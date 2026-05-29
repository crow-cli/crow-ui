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
use tracing::{info, warn};

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

/// A queued prompt message, owned by the backend.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedItem {
    pub id: String,
    pub text: String,
    pub blocks: Vec<acp::ContentBlock>,
}

/// Behavior when sending a prompt while another is running.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptBehavior {
    /// Append to queue, don't interrupt current turn.
    AddToQueue,
    /// Cancel current turn, run this prompt, preserve queue for after.
    SkipQueueAndRun,
    /// Cancel current turn, clear queue, run this prompt.
    CancelAllAndRun,
}

/// A running ACP session owned by the backend.
pub struct AcpSession {
    /// Unique connection ID (distinct from agent_id and session_id).
    pub connection_id: String,
    /// ACP session ID — empty until new_session or load_session succeeds.
    session_id: parking_lot::Mutex<String>,
    /// Agent process ID (from AgentManager).
    pub agent_id: String,
    pub agent_name: String,
    pub cwd: String,
    config_options: parking_lot::Mutex<Option<Value>>,
    modes: parking_lot::Mutex<Option<Value>>,

    stdin_tx: mpsc::Sender<String>,
    pending_requests: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
    events_tx: broadcast::Sender<SessionEvent>,
    next_id: AtomicU64,
    _io_task: tokio::task::JoinHandle<()>,

    /// Current prompt turn state — backend is source of truth.
    pub prompt_turn_state: Arc<Mutex<PromptTurnState>>,
    /// Queued prompts — backend owns this so it survives refresh and syncs across tabs.
    pub queued_items: Arc<Mutex<Vec<QueuedItem>>>,
    /// Terminal manager for killing active terminals on cancel.
    terminals: Arc<crow_ui_acp::terminals::AcpTerminalManager>,
    /// Active terminal IDs created by this session during current prompt turn.
    pub active_terminals: Arc<Mutex<std::collections::HashSet<String>>>,
    /// Shared cell so the I/O task knows the current session ID.
    session_id_cell: Arc<Mutex<String>>,
}

/// Manager for multiple backend-owned ACP sessions.
pub struct AcpSessionManager {
    /// Active sessions keyed by session_id.
    sessions: Mutex<HashMap<String, Arc<AcpSession>>>,
    /// Initialized but unbound connections keyed by connection_id.
    /// These have completed initialize but not yet session/new or session/load.
    connections: Mutex<HashMap<String, Arc<AcpSession>>>,
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
    /// Spawn an agent process and start the I/O loop.
    /// Returns an Arc with empty session_id — call initialize() then new_session() or load_session().
    pub async fn spawn(
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
        let active_terminals = Arc::new(Mutex::new(std::collections::HashSet::new()));
        let active_terminals_for_io = active_terminals.clone();

        let connection_id = uuid::Uuid::new_v4().to_string();

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
                            &active_terminals_for_io,
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
        let queued_items = Arc::new(Mutex::new(Vec::new()));
        let terminals = agent_manager.terminals.clone();

        let session = Self {
            connection_id: connection_id.clone(),
            session_id: parking_lot::Mutex::new(String::new()),
            agent_id: agent_id.clone(),
            agent_name: config.name.clone(),
            cwd: cwd.clone(),
            config_options: parking_lot::Mutex::new(None),
            modes: parking_lot::Mutex::new(None),
            stdin_tx,
            pending_requests,
            events_tx,
            next_id: AtomicU64::new(1),
            _io_task: io_task,
            prompt_turn_state,
            queued_items,
            terminals,
            active_terminals,
            session_id_cell,
        };

        info!(
            "ACP connection spawned: {} (agent: {}, cwd: {})",
            connection_id, agent_id, cwd
        );

        Ok(Arc::new(session))
    }

    /// Get the current session ID.
    pub fn session_id(&self) -> String {
        self.session_id.lock().clone()
    }

    /// Get config options.
    pub fn config_options(&self) -> Option<Value> {
        self.config_options.lock().clone()
    }

    /// Get modes.
    pub fn modes(&self) -> Option<Value> {
        self.modes.lock().clone()
    }

    /// Send initialize request and wait for response.
    pub async fn initialize(&self) -> Result<acp::InitializeResponse> {
        let init_req = acp::InitializeRequest::new(acp::ProtocolVersion::V1)
            .client_capabilities(
                acp::ClientCapabilities::new()
                    .fs(acp::FileSystemCapabilities::new().read_text_file(true).write_text_file(true))
                    .terminal(true),
            )
            .client_info(acp::Implementation::new("crow-ui", env!("CARGO_PKG_VERSION")));

        self.request("initialize", init_req).await.context("initialize failed")
    }

    /// Send session/new and bind this connection to a new session.
    /// Updates self.session_id on success.
    pub async fn new_session(
        &self,
        mcp_servers: Vec<acp::McpServer>,
    ) -> Result<acp::NewSessionResponse> {
        let new_session_req = acp::NewSessionRequest::new(&self.cwd).mcp_servers(mcp_servers);
        let resp: acp::NewSessionResponse = self
            .request("session/new", new_session_req)
            .await
            .context("newSession failed")?;

        let sid = resp.session_id.0.to_string();
        *self.session_id.lock() = sid.clone();
        *self.session_id_cell.lock().await = sid.clone();
        *self.config_options.lock() = serde_json::to_value(&resp.config_options).ok();
        *self.modes.lock() = serde_json::to_value(&resp.modes).ok();

        info!(
            "ACP session created: {} (connection: {}, agent: {}, cwd: {})",
            sid, self.connection_id, self.agent_id, self.cwd
        );

        Ok(resp)
    }

    /// Send session/load and bind this connection to an existing session.
    /// Updates self.session_id on success.
    pub async fn load_session(
        &self,
        target_session_id: &str,
        cwd: &str,
        mcp_servers: Vec<acp::McpServer>,
    ) -> Result<Value> {
        #[derive(Debug, Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Params {
            cwd: String,
            session_id: String,
            mcp_servers: Vec<acp::McpServer>,
        }
        let params = Params {
            cwd: cwd.to_string(),
            session_id: target_session_id.to_string(),
            mcp_servers,
        };
        let result = self.request::<_, Value>("session/load", params).await?;

        let sid = target_session_id.to_string();
        *self.session_id.lock() = sid.clone();
        *self.session_id_cell.lock().await = sid.clone();
        *self.config_options.lock() = result.get("configOptions").cloned();
        *self.modes.lock() = result.get("modes").cloned();

        info!(
            "ACP session loaded: {} (connection: {}, agent: {})",
            sid, self.connection_id, self.agent_id
        );

        Ok(result)
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
        let sid = self.session_id();
        eprintln!("[BROADCAST PROMPT STATE] session={} state={:?}", sid, state);
        let session_update = match &state {
            PromptTurnState::Idle => serde_json::json!({ "sessionUpdate": "prompt_state", "status": "idle" }),
            PromptTurnState::Running => serde_json::json!({ "sessionUpdate": "prompt_state", "status": "running" }),
            PromptTurnState::Complete { stop_reason } => serde_json::json!({ "sessionUpdate": "prompt_complete", "stopReason": stop_reason }),
            PromptTurnState::Cancelled => serde_json::json!({ "sessionUpdate": "prompt_complete", "stopReason": "cancelled" }),
            PromptTurnState::Error { message } => serde_json::json!({ "sessionUpdate": "prompt_complete", "stopReason": "error", "error": message }),
        };
        let _ = self.events_tx.send(SessionEvent::Update {
            session_id: sid,
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

        // Kill all active terminals for this session — the agent is likely blocked
        // waiting for terminal/waitForExit and can't process session/cancel until we respond.
        let terminals_to_kill: Vec<String> = {
            let mut active = self.active_terminals.lock().await;
            let ids: Vec<String> = active.drain().collect();
            ids
        };
        for term_id in terminals_to_kill {
            info!("Killing terminal {} for cancelled session {}", term_id, self.session_id());
            self.terminals.kill_terminal(&term_id).await;
        }

        let notif = acp::CancelNotification::new(acp::SessionId::new(self.session_id()));
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
            session_id: self.session_id(),
            config_id: config_id.to_string(),
            value: value.to_string(),
        };
        let result = self.request::<_, Value>("session/set_config_option", params).await?;
        let config_options = result.get("configOptions")
            .ok_or_else(|| anyhow::anyhow!("agent response missing configOptions"))?
            .clone();
        Ok(config_options)
    }

    /// Ask the agent to list sessions for a given cwd.
    pub async fn list_sessions(&self, cwd: &str) -> Result<Value> {
        #[derive(Debug, Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Params {
            cwd: String,
        }
        let params = Params {
            cwd: cwd.to_string(),
        };
        self.request::<_, Value>("session/list", params).await
    }

    /// Send a prompt. Returns Ok when complete, Err on failure.
    /// Broadcasts prompt_state → running when dispatching and prompt_complete when done.
    /// After completion, auto-drains the queue if items are waiting.
    pub async fn prompt(&self, blocks: Vec<acp::ContentBlock>) -> Result<()> {
        self.run_prompt(blocks).await.map(|_| ())
    }

    /// Core prompt runner — sets state, sends to agent, broadcasts result.
    async fn run_prompt(&self, blocks: Vec<acp::ContentBlock>) -> Result<acp::PromptResponse> {
        // Clear any stale active terminals from previous turns
        {
            let mut active = self.active_terminals.lock().await;
            active.clear();
        }

        // Broadcast user message so frontend can display it in chat history.
        let user_text = blocks.iter().filter_map(|b| {
            if let acp::ContentBlock::Text(t) = b { Some(t.text.clone()) } else { None }
        }).collect::<Vec<_>>().join("");
        let _ = self.events_tx.send(SessionEvent::Update {
            session_id: self.session_id(),
            update: serde_json::json!({
                "sessionUpdate": "user_message_chunk",
                "content": { "text": user_text },
            }),
        });

        {
            let mut state = self.prompt_turn_state.lock().await;
            *state = PromptTurnState::Running;
        }
        self.broadcast_prompt_state(PromptTurnState::Running);

        let req = acp::PromptRequest::new(
            acp::SessionId::new(self.session_id()),
            blocks,
        );
        let result = self.request_no_timeout::<_, acp::PromptResponse>("session/prompt", req).await;

        // Clear active terminals when turn ends (they either exited or we cancelled)
        {
            let mut active = self.active_terminals.lock().await;
            active.clear();
        }

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

    /// Send a prompt with behavior control.
    /// - If idle: runs immediately regardless of behavior.
    /// - If running:
    ///   - AddToQueue: appends to queue, returns Ok immediately.
    ///   - SkipQueueAndRun: cancels current, runs this, preserves queue.
    ///   - CancelAllAndRun: cancels current, clears queue, runs this.
    pub async fn prompt_with_behavior(
        &self,
        blocks: Vec<acp::ContentBlock>,
        behavior: PromptBehavior,
    ) -> Result<()> {
        let is_running = {
            let state = self.prompt_turn_state.lock().await;
            matches!(*state, PromptTurnState::Running)
        };

        if !is_running {
            // Idle — run immediately, then auto-drain queue
            self.run_prompt(blocks).await?;
            self.drain_queue().await;
            return Ok(());
        }

        // Currently running — behavior decides what to do
        match behavior {
            PromptBehavior::AddToQueue => {
                let text = blocks.iter().filter_map(|b| {
                    if let acp::ContentBlock::Text(t) = b { Some(t.text.clone()) } else { None }
                }).collect::<Vec<_>>().join("");
                let item = QueuedItem {
                    id: format!("queue-{}-{}", self.session_id(), self.next_id.fetch_add(1, Ordering::SeqCst)),
                    text,
                    blocks,
                };
                self.queue_push(item).await;
                Ok(())
            }
            PromptBehavior::SkipQueueAndRun => {
                self.cancel().await?;
                self.run_prompt(blocks).await?;
                self.drain_queue().await;
                Ok(())
            }
            PromptBehavior::CancelAllAndRun => {
                self.cancel().await?;
                self.queue_clear().await;
                self.run_prompt(blocks).await?;
                self.drain_queue().await;
                Ok(())
            }
        }
    }

    /// Auto-drain the queue when prompt completes.
    /// Pops front item and runs it if any are waiting.
    async fn drain_queue(&self) {
        while let Some(item) = self.queue_pop().await {
            eprintln!("[ACP SESSION] auto-draining queue item {}", item.id);
            let _ = self.run_prompt(item.blocks).await;
            // Loop continues — if more items were added during the prompt, they'll run too
        }
    }

    /// Subscribe to session events (updates, disconnects).
    pub fn subscribe(&self) -> broadcast::Receiver<SessionEvent> {
        self.events_tx.subscribe()
    }

    // ─── Queue management ─────────────────────────────────────────────────────

    /// Get current queue items.
    pub async fn get_queue(&self) -> Vec<QueuedItem> {
        self.queued_items.lock().await.clone()
    }

    /// Add an item to the queue.
    pub async fn queue_push(&self, item: QueuedItem) {
        self.queued_items.lock().await.push(item);
        self.broadcast_queue();
    }

    /// Remove an item from the queue by id.
    pub async fn queue_remove(&self, id: &str) -> bool {
        let mut q = self.queued_items.lock().await;
        let before = q.len();
        q.retain(|i| i.id != id);
        let changed = q.len() != before;
        drop(q);
        if changed {
            self.broadcast_queue();
        }
        changed
    }

    /// Update an item in the queue by id.
    pub async fn queue_update(&self, id: &str, text: String, blocks: Vec<acp::ContentBlock>) -> bool {
        let mut q = self.queued_items.lock().await;
        if let Some(item) = q.iter_mut().find(|i| i.id == id) {
            item.text = text;
            item.blocks = blocks;
            drop(q);
            self.broadcast_queue();
            true
        } else {
            false
        }
    }

    /// Clear the entire queue.
    pub async fn queue_clear(&self) {
        let mut q = self.queued_items.lock().await;
        if !q.is_empty() {
            q.clear();
            drop(q);
            self.broadcast_queue();
        }
    }

    /// Pop the front item from the queue (returns None if empty).
    pub async fn queue_pop(&self) -> Option<QueuedItem> {
        let mut q = self.queued_items.lock().await;
        let item = q.pop();
        drop(q);
        if item.is_some() {
            self.broadcast_queue();
        }
        item
    }

    /// Reorder queue items (new order of ids).
    pub async fn queue_reorder(&self, ids: Vec<String>) -> bool {
        let mut q = self.queued_items.lock().await;
        if q.len() != ids.len() {
            return false;
        }
        let mut new_q = Vec::with_capacity(q.len());
        for id in &ids {
            if let Some(pos) = q.iter().position(|i| i.id == *id) {
                new_q.push(q.remove(pos));
            } else {
                return false;
            }
        }
        *q = new_q;
        drop(q);
        self.broadcast_queue();
        true
    }

    fn broadcast_queue(&self) {
        let session_id = self.session_id();
        let items = {
            // We can't hold the lock across await, but this is sync so we just clone
            if let Ok(q) = self.queued_items.try_lock() {
                q.clone()
            } else {
                return; // Lock contended, skip broadcast
            }
        };
        let _ = self.events_tx.send(SessionEvent::Update {
            session_id,
            update: serde_json::json!({
                "sessionUpdate": "queue_changed",
                "items": items,
            }),
        });
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
    active_terminals: &Arc<Mutex<std::collections::HashSet<String>>>,
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
        let session_id = session_id_cell.lock().await.clone();
        // Spawn request handling as a separate task so the I/O loop keeps reading.
        // This allows concurrent requests (e.g., terminal/kill while terminal/waitForExit is pending).
        let terminals = terminals.clone();
        let active_terminals = active_terminals.clone();
        let stdin_tx = stdin_tx.clone();
        let method = method.to_string();
        tokio::spawn(async move {
            let result = handle_agent_request(&method, params, &terminals, &active_terminals, &session_id).await;
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
        });
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
    active_terminals: &Mutex<std::collections::HashSet<String>>,
    session_id: &str,
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
            let timeout_ms = params.get("timeoutMs").and_then(|v| v.as_u64());
            // Default 60s timeout so agents can't accidentally leave terminals hanging forever.
            let timeout_ms = timeout_ms.or(Some(60_000));

            match terminals.create_terminal(command, &args, &env, cwd, output_byte_limit, timeout_ms, Some(session_id.to_string())).await {
                Ok(id) => {
                    active_terminals.lock().await.insert(id.clone());
                    Ok(serde_json::json!({"terminalId": id}))
                }
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
            // Poll until terminal exits. Return immediately if killed (timeout or cancel).
            loop {
                match terminals.terminal_info(id).await {
                    Some((exited, exit_code, signal)) => {
                        if exited {
                            return Ok(serde_json::json!({
                                "exitCode": exit_code,
                                "signal": signal,
                            }));
                        }
                        // Check if we should still be waiting — terminal may have been killed
                        // but the exited flag hasn't propagated yet. Short sleep to avoid tight loop.
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
            connections: Mutex::new(HashMap::new()),
            agent_manager,
        }
    }

    /// Spawn + initialize a new connection.
    /// Returns the connection_id.
    pub async fn init_connection(
        &self,
        config: AgentConfig,
        cwd: String,
    ) -> Result<String> {
        let session = AcpSession::spawn(&self.agent_manager, config, cwd).await?;
        session.initialize().await?;
        let connection_id = session.connection_id.clone();
        self.connections.lock().await.insert(connection_id.clone(), session);
        Ok(connection_id)
    }

    /// Bind an unbound connection to a new session (session/new).
    /// Moves the connection from `connections` to `sessions`.
    /// Returns the session Arc.
    pub async fn bind_new_session(
        &self,
        connection_id: &str,
        mcp_servers: Vec<acp::McpServer>,
        forward_tx: broadcast::Sender<SessionEvent>,
    ) -> Result<Arc<AcpSession>> {
        let session = {
            let mut conns = self.connections.lock().await;
            conns.remove(connection_id)
                .ok_or_else(|| anyhow::anyhow!("Connection not found: {}", connection_id))?
        };

        session.new_session(mcp_servers).await?;
        let session_id = session.session_id();

        // Forward session events to the global channel
        let mut rx = session.subscribe();
        let sid = session_id.clone();
        tokio::spawn(async move {
            while let Ok(event) = rx.recv().await {
                let _ = forward_tx.send(event);
            }
            let _ = forward_tx.send(SessionEvent::Disconnected { session_id: sid.clone() });
        });

        self.sessions.lock().await.insert(session_id, session.clone());
        Ok(session)
    }

    /// Bind an unbound connection to an existing session (session/load).
    /// Moves the connection from `connections` to `sessions`.
    /// Returns the session Arc.
    pub async fn bind_load_session(
        &self,
        connection_id: &str,
        target_session_id: &str,
        cwd: &str,
        mcp_servers: Vec<acp::McpServer>,
        forward_tx: broadcast::Sender<SessionEvent>,
    ) -> Result<Arc<AcpSession>> {
        let session = {
            let mut conns = self.connections.lock().await;
            conns.remove(connection_id)
                .ok_or_else(|| anyhow::anyhow!("Connection not found: {}", connection_id))?
        };

        session.load_session(target_session_id, cwd, mcp_servers).await?;
        let session_id = session.session_id();

        // Forward session events to the global channel
        let mut rx = session.subscribe();
        let sid = session_id.clone();
        tokio::spawn(async move {
            while let Ok(event) = rx.recv().await {
                let _ = forward_tx.send(event);
            }
            let _ = forward_tx.send(SessionEvent::Disconnected { session_id: sid.clone() });
        });

        self.sessions.lock().await.insert(session_id, session.clone());
        Ok(session)
    }

    /// Load a different session on an already-bound session.
    /// Updates the session_id and the sessions map key.
    pub async fn switch_session(
        &self,
        current_session_id: &str,
        target_session_id: &str,
        cwd: &str,
        mcp_servers: Vec<acp::McpServer>,
    ) -> Result<Arc<AcpSession>> {
        let session = {
            let mut sessions = self.sessions.lock().await;
            sessions.remove(current_session_id)
                .ok_or_else(|| anyhow::anyhow!("Session not found: {}", current_session_id))?
        };

        session.load_session(target_session_id, cwd, mcp_servers).await?;
        let new_session_id = session.session_id();

        self.sessions.lock().await.insert(new_session_id, session.clone());
        Ok(session)
    }

    /// List sessions via an unbound or bound connection.
    pub async fn list_sessions_via_connection(
        &self,
        connection_id: &str,
        cwd: &str,
    ) -> Result<Value> {
        // Try connections first, then sessions
        let session = {
            let conns = self.connections.lock().await;
            if let Some(s) = conns.get(connection_id) {
                s.clone()
            } else {
                let sessions = self.sessions.lock().await;
                sessions.get(connection_id)
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!("Connection or session not found: {}", connection_id))?
            }
        };
        session.list_sessions(cwd).await
    }

    /// Backward compat: spawn + initialize + new_session in one shot.
    pub async fn create_session(
        &self,
        name: String,
        command: String,
        args: Vec<String>,
        env: Vec<String>,
        cwd: String,
        config_file: Option<String>,
        mcp_servers: Vec<acp::McpServer>,
        forward_tx: broadcast::Sender<SessionEvent>,
    ) -> Result<Arc<AcpSession>> {
        let mut final_args = args;
        if let Some(path) = config_file {
            let expanded = if path.starts_with("~/") {
                std::env::var("HOME")
                    .map(|home| format!("{}{}", home, &path[1..]))
                    .unwrap_or(path)
            } else {
                path
            };
            final_args.push("--config-file".to_string());
            final_args.push(expanded);
        }
        let config = AgentConfig {
            name,
            command,
            args: final_args,
            env,
        };

        // Spawn + initialize
        let session = AcpSession::spawn(&self.agent_manager, config, cwd).await?;
        session.initialize().await?;

        // New session
        session.new_session(mcp_servers).await?;
        let session_id = session.session_id();

        // Forward session events
        let mut rx = session.subscribe();
        let sid = session_id.clone();
        tokio::spawn(async move {
            while let Ok(event) = rx.recv().await {
                let _ = forward_tx.send(event);
            }
            let _ = forward_tx.send(SessionEvent::Disconnected { session_id: sid.clone() });
        });

        self.sessions.lock().await.insert(session_id, session.clone());
        Ok(session)
    }

    pub async fn get_session(&self, session_id: &str) -> Option<Arc<AcpSession>> {
        self.sessions.lock().await.get(session_id).cloned()
    }

    pub async fn get_connection(&self, connection_id: &str) -> Option<Arc<AcpSession>> {
        self.connections.lock().await.get(connection_id).cloned()
    }

    pub async fn close_session(&self, session_id: &str) {
        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.remove(session_id) {
            info!("Closing ACP session {}", session_id);
            let _ = self.agent_manager.kill(&session.agent_id).await;
        }
    }

    pub async fn close_connection(&self, connection_id: &str) {
        let mut conns = self.connections.lock().await;
        if let Some(session) = conns.remove(connection_id) {
            info!("Closing ACP connection {}", connection_id);
            let _ = self.agent_manager.kill(&session.agent_id).await;
        }
    }

    pub async fn list_active_sessions(&self) -> Vec<String> {
        self.sessions.lock().await.keys().cloned().collect()
    }

    pub async fn list_connections(&self) -> Vec<String> {
        self.connections.lock().await.keys().cloned().collect()
    }
}
