//! Backend-owned ACP session.
//!
//! Speaks ACP JSON-RPC over the agent's stdin/stdout via AgentManager.
//! Handles client tool requests (fs, terminal) directly and forwards session updates
//! to connected frontends over the main WebSocket.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{broadcast, mpsc, oneshot, Mutex};
use tracing::{error, info, warn};

use agent_client_protocol_schema as acp;

use crow_ui_acp::{AgentConfig, AgentManager};

// ─── Types ──────────────────────────────────────────────────────────────────

/// Event broadcast to frontends when something happens in a session.
#[derive(Clone, Debug)]
pub enum SessionEvent {
    /// A session/update notification from the agent.
    Update {
        session_id: String,
        update: Value,
    },
    /// The agent process exited or the connection was lost.
    Disconnected {
        session_id: String,
    },
}

/// Lifecycle state of a prompt turn, owned by the backend.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PromptTurnState {
    #[default]
    Idle,
    /// We sent session/prompt and are awaiting the agent's PromptResponse.
    Running,
    /// Agent responded with a stopReason.
    Complete {
        stop_reason: String,
    },
    /// Client called session/cancel.
    Cancelled,
    /// Something went wrong (timeout, disconnect, etc.).
    Error {
        message: String,
    },
}

/// A running ACP session owned by the backend.
pub struct AcpSession {
    pub session_id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub cwd: String,
    pub config_options: Option<Value>,
    pub modes: Option<Value>,

    stdin_tx: mpsc::Sender<String>,
    pending_requests: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
    events_tx: broadcast::Sender<SessionEvent>,
    next_id: AtomicU64,
    _io_task: tokio::task::JoinHandle<()>,

    /// Current prompt turn state — backend is source of truth.
    pub prompt_turn_state: Arc<Mutex<PromptTurnState>>,
}

/// Manager for multiple backend-owned ACP sessions.
pub struct AcpSessionManager {
    sessions: Mutex<HashMap<String, Arc<AcpSession>>>,
    agent_manager: Arc<AgentManager>,
}

// ─── JSON-RPC types ─────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct JsonRpcRequest<T> {
    jsonrpc: &'static str,
    id: u64,
    method: String,
    params: T,
}

#[derive(Debug, Serialize)]
struct JsonRpcNotification<T> {
    jsonrpc: &'static str,
    method: String,
    params: T,
}

#[derive(Debug, Deserialize)]
struct JsonRpcResponse {
    id: u64,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<JsonRpcError>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

// ─── AcpSession implementation ──────────────────────────────────────────────

impl AcpSession {
    /// Spawn an agent, perform initialize + newSession handshake.
    pub async fn create(
        agent_manager: &AgentManager,
        config: AgentConfig,
        cwd: String,
    ) -> Result<Arc<Self>> {
        let agent_id = agent_manager
            .spawn(&config, &cwd)
            .await
            .context("failed to spawn agent")?;

        let stdin_tx = agent_manager
            .get_stdin(&agent_id)
            .await
            .context("agent disappeared immediately")?;

        // Subscribe to this agent's RAW stdout lines (per-agent channel prevents cross-session reads)
        let agent_events_tx_raw = agent_manager
            .get_events_tx_raw(&agent_id)
            .await
            .context("agent disappeared immediately")?;
        let mut stdout_rx = agent_events_tx_raw.subscribe();

        let events_tx = broadcast::Sender::new(1024);
        let pending_requests = Arc::new(Mutex::new(HashMap::<
            u64,
            oneshot::Sender<Result<Value, String>>,
        >::new()));

        let pending_clone = pending_requests.clone();
        let broadcast_tx = events_tx.clone();
        let session_id_cell = Arc::new(Mutex::new(String::new()));
        let session_id_cell_clone = session_id_cell.clone();
        let stdin_tx_clone = stdin_tx.clone();
        let terminals_clone = agent_manager.terminals.clone();

        let io_task = tokio::spawn(async move {
            loop {
                match stdout_rx.recv().await {
                    Ok(raw_line) => {
                        if let Err(e) = handle_agent_line(
                            &raw_line,
                            &pending_clone,
                            &broadcast_tx,
                            &session_id_cell_clone,
                            &stdin_tx_clone,
                            &terminals_clone,
                        )
                        .await
                        {
                            warn!("ACP parse error: {e}");
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            let sid = session_id_cell_clone.lock().await.clone();
            if !sid.is_empty() {
                let _ = broadcast_tx.send(SessionEvent::Disconnected { session_id: sid });
            }
        });

        let prompt_turn_state = Arc::new(Mutex::new(PromptTurnState::Idle));

        let mut session = Self {
            session_id: String::new(),
            agent_id: agent_id.clone(),
            agent_name: config.name.clone(),
            cwd: cwd.clone(),
            config_options: None,
            modes: None,
            stdin_tx,
            pending_requests,
            events_tx,
            next_id: AtomicU64::new(1),
            _io_task: io_task,
            prompt_turn_state,
        };

        // ── ACP handshake ──

        // 1. Initialize
        let init_req = acp::InitializeRequest::new(acp::ProtocolVersion::V1)
            .client_capabilities(
                acp::ClientCapabilities::new()
                    .fs(acp::FileSystemCapabilities::new().read_text_file(true).write_text_file(true))
                    .terminal(true),
            )
            .client_info(acp::Implementation::new("crow-ui", env!("CARGO_PKG_VERSION")));

        let _init_resp: acp::InitializeResponse = session
            .request("initialize", init_req)
            .await
            .context("initialize failed")?;

        // 2. New session
        let new_session_req = acp::NewSessionRequest::new(&cwd);
        let new_session_resp: acp::NewSessionResponse = session
            .request("session/new", new_session_req)
            .await
            .context("newSession failed")?;

        session.session_id = new_session_resp.session_id.0.to_string();
        session.config_options = serde_json::to_value(&new_session_resp.config_options).ok();
        session.modes = serde_json::to_value(&new_session_resp.modes).ok();
        *session_id_cell.lock().await = session.session_id.clone();

        info!(
            "ACP session created: {} (agent: {}, cwd: {})",
            session.session_id, session.agent_id, cwd
        );

        Ok(Arc::new(session))
    }

    /// Send a JSON-RPC request and wait for the response (with 30s timeout).
    async fn request<Req: Serialize, Resp: for<'de> Deserialize<'de>>(
        &self,
        method: &str,
        params: Req,
    ) -> Result<Resp> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let req = JsonRpcRequest {
            jsonrpc: "2.0",
            id,
            method: method.to_string(),
            params,
        };
        let line = serde_json::to_string(&req).context("serialize request")?;

        let (tx, rx) = oneshot::channel();
        self.pending_requests.lock().await.insert(id, tx);

        self.stdin_tx
            .send(line)
            .await
            .map_err(|_| anyhow::anyhow!("agent stdin closed"))?;

        let result = tokio::time::timeout(std::time::Duration::from_secs(30), rx)
            .await
            .map_err(|_| anyhow::anyhow!("request timeout: {method}"))?
            .map_err(|_| anyhow::anyhow!("response channel closed"))?;

        match result {
            Ok(val) => serde_json::from_value(val).context("deserialize response"),
            Err(msg) => Err(anyhow::anyhow!("ACP error: {msg}")),
        }
    }

    /// Send a JSON-RPC request and wait indefinitely (no timeout).
    /// Used for session/prompt which can take minutes.
    async fn request_no_timeout<Req: Serialize, Resp: for<'de> Deserialize<'de>>(
        &self,
        method: &str,
        params: Req,
    ) -> Result<Resp> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let req = JsonRpcRequest {
            jsonrpc: "2.0",
            id,
            method: method.to_string(),
            params,
        };
        let line = serde_json::to_string(&req).context("serialize request")?;

        let (tx, rx) = oneshot::channel();
        self.pending_requests.lock().await.insert(id, tx);

        self.stdin_tx
            .send(line)
            .await
            .map_err(|_| anyhow::anyhow!("agent stdin closed"))?;

        let result = rx
            .await
            .map_err(|_| anyhow::anyhow!("response channel closed"))?;

        match result {
            Ok(val) => serde_json::from_value(val).context("deserialize response"),
            Err(msg) => Err(anyhow::anyhow!("ACP error: {msg}")),
        }
    }

    /// Broadcast a synthetic session/update so the frontend receives prompt lifecycle events
    /// on the same channel as regular agent updates.
    fn broadcast_prompt_state(&self, state: PromptTurnState) {
        eprintln!("[BROADCAST PROMPT STATE] session={} state={:?}", self.session_id, state);
        let session_update = match &state {
            PromptTurnState::Idle => serde_json::json!({ "sessionUpdate": "prompt_state", "status": "idle" }),
            PromptTurnState::Running => serde_json::json!({ "sessionUpdate": "prompt_state", "status": "running" }),
            PromptTurnState::Complete { stop_reason } => serde_json::json!({ "sessionUpdate": "prompt_complete", "stopReason": stop_reason }),
            PromptTurnState::Cancelled => serde_json::json!({ "sessionUpdate": "prompt_complete", "stopReason": "cancelled" }),
            PromptTurnState::Error { message } => serde_json::json!({ "sessionUpdate": "prompt_complete", "stopReason": "error", "error": message }),
        };
        let _ = self.events_tx.send(SessionEvent::Update {
            session_id: self.session_id.clone(),
            update: session_update,
        });
    }

    /// Send a JSON-RPC notification (no response expected).
    async fn notify<Req: Serialize>(&self, method: &str, params: Req) -> Result<()> {
        let notif = JsonRpcNotification {
            jsonrpc: "2.0",
            method: method.to_string(),
            params,
        };
        let line = serde_json::to_string(&notif).context("serialize notification")?;
        self.stdin_tx
            .send(line)
            .await
            .map_err(|_| anyhow::anyhow!("agent stdin closed"))?;
        Ok(())
    }

    /// Cancel the current prompt turn.
    pub async fn cancel(&self) -> Result<()> {
        {
            let mut state = self.prompt_turn_state.lock().await;
            *state = PromptTurnState::Cancelled;
        }
        self.broadcast_prompt_state(PromptTurnState::Cancelled);
        let notif = acp::CancelNotification::new(acp::SessionId::new(self.session_id.clone()));
        self.notify("session/cancel", notif).await
    }

    /// Set a session config option (e.g. model).
    /// Returns the configOptions array (extracted from the agent's response wrapper).
    pub async fn set_config_option(&self, config_id: &str, value: &str) -> Result<Value> {
        #[derive(Debug, Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Params {
            session_id: String,
            config_id: String,
            value: String,
        }
        let params = Params {
            session_id: self.session_id.clone(),
            config_id: config_id.to_string(),
            value: value.to_string(),
        };
        let result = self.request::<_, Value>("session/set_config_option", params).await?;
        let config_options = result.get("configOptions")
            .ok_or_else(|| anyhow::anyhow!("agent response missing configOptions"))?
            .clone();
        Ok(config_options)
    }

    /// Send a prompt. Returns the full PromptResponse (including stopReason).
    /// Broadcasts prompt_state → running when dispatching and prompt_complete when done.
    pub async fn prompt(&self, blocks: Vec<acp::ContentBlock>) -> Result<acp::PromptResponse> {
        {
            let mut state = self.prompt_turn_state.lock().await;
            *state = PromptTurnState::Running;
        }
        self.broadcast_prompt_state(PromptTurnState::Running);

        let req = acp::PromptRequest::new(
            acp::SessionId::new(self.session_id.clone()),
            blocks,
        );
        let result = self.request_no_timeout::<_, acp::PromptResponse>("session/prompt", req).await;

        match &result {
            Ok(resp) => {
                let stop_reason = serde_json::to_string(&resp.stop_reason)
                    .unwrap_or_default()
                    .trim_matches('"')
                    .to_string();
                let state = PromptTurnState::Complete { stop_reason };
                {
                    let mut s = self.prompt_turn_state.lock().await;
                    *s = state.clone();
                }
                self.broadcast_prompt_state(state);
            }
            Err(e) => {
                let state = PromptTurnState::Error { message: e.to_string() };
                {
                    let mut s = self.prompt_turn_state.lock().await;
                    *s = state.clone();
                }
                self.broadcast_prompt_state(state);
            }
        }

        result
    }

    /// Subscribe to session events (updates, disconnects).
    pub fn subscribe(&self) -> broadcast::Receiver<SessionEvent> {
        self.events_tx.subscribe()
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async fn handle_agent_line(
    line: &str,
    pending: &Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    broadcast_tx: &broadcast::Sender<SessionEvent>,
    session_id_cell: &Mutex<String>,
    stdin_tx: &mpsc::Sender<String>,
    terminals: &Arc<crow_ui_acp::terminals::AcpTerminalManager>,
) -> Result<()> {
    eprintln!("[ACP RAW] {}", line);
    let val: Value = serde_json::from_str(line).context("parse agent line")?;

    // Is it a response?
    if val.get("id").is_some() && (val.get("result").is_some() || val.get("error").is_some()) {
        let resp: JsonRpcResponse = serde_json::from_value(val)?;
        eprintln!("[ACP RESPONSE] id={} error={:?}", resp.id, resp.error);
        let mut map = pending.lock().await;
        if let Some(sender) = map.remove(&resp.id) {
            if let Some(err) = resp.error {
                let _ = sender.send(Err(format!("{}: {}", err.code, err.message)));
            } else {
                let _ = sender.send(Ok(resp.result.unwrap_or(Value::Null)));
            }
        } else {
            eprintln!("[ACP RESPONSE] id={} NO PENDING REQUEST FOUND", resp.id);
        }
        return Ok(());
    }

    // Is it a request (agent → client)?  MUST check before notification because requests also have "method".
    if let (Some(id), Some(method)) = (val.get("id").and_then(|v| v.as_u64()), val.get("method").and_then(|m| m.as_str())) {
        let params = val.get("params").cloned().unwrap_or(Value::Null);
        eprintln!("[ACP REQUEST] id={} method={} params={}", id, method, params);
        let result = handle_agent_request(method, params, terminals).await;
        let response = match result {
            Ok(res) => {
                eprintln!("[ACP REQUEST] id={} method={} OK result={}", id, method, res);
                serde_json::json!({"jsonrpc": "2.0", "id": id, "result": res})
            }
            Err(err) => {
                eprintln!("[ACP REQUEST] id={} method={} ERROR: {}", id, method, err);
                serde_json::json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32600, "message": err}})
            }
        };
        if let Err(e) = stdin_tx.send(response.to_string()).await {
            eprintln!("[ACP REQUEST] id={} FAILED TO SEND RESPONSE: {}", id, e);
        }
        return Ok(());
    }

    // Is it a notification?
    if let Some(method) = val.get("method").and_then(|m| m.as_str()) {
        eprintln!("[ACP NOTIFICATION] method={}", method);
        if method == "session/update" {
            // Extract sessionId from the notification itself — don't rely on session_id_cell
            // which races with the io_task.
            if let Some(sid) = val.get("params").and_then(|p| p.get("sessionId")).and_then(|v| v.as_str()) {
                let inner_update = val
                    .get("params")
                    .and_then(|p| p.get("update"))
                    .cloned()
                    .unwrap_or(Value::Null);
                eprintln!("[ACP NOTIFICATION] session/update session_id={} inner_update={}", sid, inner_update);
                let _ = broadcast_tx.send(SessionEvent::Update {
                    session_id: sid.to_string(),
                    update: inner_update,
                });
            } else {
                eprintln!("[ACP NOTIFICATION] session/update DROPPED — no sessionId in params");
            }
        } else {
            eprintln!("[ACP NOTIFICATION] UNHANDLED method={}", method);
        }
        return Ok(());
    }

    eprintln!("[ACP UNKNOWN] could not classify line: {}", line);
    Ok(())
}

async fn handle_agent_request(
    method: &str,
    params: Value,
    terminals: &Arc<crow_ui_acp::terminals::AcpTerminalManager>,
) -> Result<Value, String> {
    match method {
        "fs/readTextFile" | "fs/read_text_file" => {
            let path = params.get("path").and_then(|v| v.as_str()).ok_or("missing path")?;
            match tokio::fs::read_to_string(path).await {
                Ok(content) => Ok(serde_json::json!({"content": content})),
                Err(e) => Err(format!("failed to read file: {e}")),
            }
        }
        "fs/writeTextFile" | "fs/write_text_file" => {
            let path = params.get("path").and_then(|v| v.as_str()).ok_or("missing path")?;
            let content = params.get("content").and_then(|v| v.as_str()).unwrap_or("");
            match tokio::fs::write(path, content).await {
                Ok(()) => Ok(serde_json::json!({"success": true})),
                Err(e) => Err(format!("failed to write file: {e}")),
            }
        }
        "terminal/create" | "terminal/createTerminal" => {
            let command = params.get("command").and_then(|v| v.as_str()).unwrap_or("");
            let args: Vec<String> = params.get("args")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let env: Vec<(String, String)> = params.get("env")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter().filter_map(|v| {
                        if let Some(s) = v.as_str() {
                            s.split_once('=').map(|(k, v)| (k.to_string(), v.to_string()))
                        } else {
                            None
                        }
                    }).collect()
                })
                .unwrap_or_default();
            let cwd = params.get("cwd").and_then(|v| v.as_str());
            let output_byte_limit = params.get("outputByteLimit").and_then(|v| v.as_u64()).map(|v| v as usize);

            match terminals.create_terminal(command, &args, &env, cwd, output_byte_limit).await {
                Ok(id) => Ok(serde_json::json!({"terminalId": id})),
                Err(e) => Err(format!("failed to create terminal: {e}")),
            }
        }
        "terminal/output" | "terminal/terminalOutput" => {
            let id = params.get("terminalId").and_then(|v| v.as_str()).ok_or("missing terminalId")?;
            match terminals.terminal_output(id).await {
                Some((output, truncated)) => Ok(serde_json::json!({
                    "output": output,
                    "truncated": truncated,
                })),
                None => Err("terminal not found".into()),
            }
        }
        "terminal/waitForExit" | "terminal/wait_for_exit" => {
            let id = params.get("terminalId").and_then(|v| v.as_str()).ok_or("missing terminalId")?;
            // Poll until terminal exits
            loop {
                match terminals.terminal_info(id).await {
                    Some((exited, exit_code, signal)) => {
                        if exited {
                            return Ok(serde_json::json!({
                                "exitCode": exit_code,
                                "signal": signal,
                            }));
                        }
                    }
                    None => return Err("terminal not found".into()),
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
        "terminal/kill" | "terminal/killTerminal" => {
            let id = params.get("terminalId").and_then(|v| v.as_str()).ok_or("missing terminalId")?;
            terminals.kill_terminal(id).await;
            Ok(serde_json::json!({"success": true}))
        }
        "terminal/release" | "terminal/releaseTerminal" => {
            let id = params.get("terminalId").and_then(|v| v.as_str()).ok_or("missing terminalId")?;
            terminals.release_terminal(id).await;
            Ok(serde_json::json!({"success": true}))
        }
        "session/requestPermission" | "session/request_permission" => {
            // Auto-grant with allow-once
            Ok(serde_json::json!({
                "outcome": {
                    "outcome": "selected",
                    "optionId": "allow-once"
                }
            }))
        }
        _ => {
            warn!("Unhandled agent request: {method}");
            Err(format!("unsupported method: {method}"))
        }
    }
}

// ─── AcpSessionManager implementation ───────────────────────────────────────

impl AcpSessionManager {
    pub fn new(agent_manager: Arc<AgentManager>) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            agent_manager,
        }
    }

    pub async fn create_session(
        &self,
        name: String,
        command: String,
        args: Vec<String>,
        env: Vec<String>,
        cwd: String,
        forward_tx: broadcast::Sender<SessionEvent>,
    ) -> Result<Arc<AcpSession>> {
        let config = AgentConfig {
            name,
            command,
            args,
            env,
        };
        let session = AcpSession::create(&self.agent_manager, config, cwd).await?;

        // Forward session events to the global channel
        let mut rx = session.subscribe();
        let session_id = session.session_id.clone();
        tokio::spawn(async move {
            while let Ok(event) = rx.recv().await {
                let _ = forward_tx.send(event);
            }
            let _ = forward_tx.send(SessionEvent::Disconnected { session_id: session_id.clone() });
        });

        let mut map = self.sessions.lock().await;
        map.insert(session.session_id.clone(), session.clone());
        Ok(session)
    }

    pub async fn get_session(&self, session_id: &str) -> Option<Arc<AcpSession>> {
        self.sessions.lock().await.get(session_id).cloned()
    }

    pub async fn close_session(&self, session_id: &str) {
        let mut map = self.sessions.lock().await;
        if let Some(session) = map.remove(session_id) {
            info!("Closing ACP session {}", session_id);
            let _ = self.agent_manager.kill(&session.agent_id).await;
        }
    }

    pub async fn list_sessions(&self) -> Vec<String> {
        self.sessions.lock().await.keys().cloned().collect()
    }
}
