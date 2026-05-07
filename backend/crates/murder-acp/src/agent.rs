//! Agent process management — spawn/kill agent subprocesses.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, Mutex};
use crate::terminals::AcpTerminalManager;
use tracing::{info, warn};

/// Configuration for an ACP agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    /// Agent name (e.g. "claude-code", "gemini-cli")
    pub name: String,
    /// Command to spawn the agent (e.g. "npx", "claude")
    pub command: String,
    /// Arguments to pass to the command
    #[serde(default)]
    pub args: Vec<String>,
    /// Environment variables (key=value pairs)
    #[serde(default)]
    pub env: Vec<String>,
}

/// A running agent subprocess.
pub struct AgentInstance {
    pub process: Child,
    /// JSON-RPC messages to agent stdin
    pub stdin_tx: tokio::sync::mpsc::Sender<String>,
}

/// Manages spawned agent subprocesses.
pub struct AgentManager {
    agents: Mutex<HashMap<String, AgentInstance>>,
    next_id: Mutex<u64>,
    /// Broadcast channel for agent stdout messages → all interested parties.
    pub events_tx: broadcast::Sender<String>,
    /// ACP terminal sessions spawned by agents.
    pub terminals: Arc<AcpTerminalManager>,
}

impl AgentManager {
    pub fn new() -> Self {
        Self {
            agents: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
            events_tx: broadcast::Sender::new(1024),
            terminals: Arc::new(AcpTerminalManager::new()),
        }
    }

    /// Spawn an agent subprocess connected via JSON-RPC over stdio.
    /// Returns the agent ID and starts a background task that pumps stdout to the broadcast channel.
    pub async fn spawn(&self, config: &AgentConfig, cwd: &str) -> Result<String> {
        let id = {
            let mut next = self.next_id.lock().await;
            let id = format!("agent_{}", *next);
            *next += 1;
            id
        };

        info!("Spawning agent '{}' (id={}) in {}", config.name, id, cwd);

        let mut cmd = Command::new(&config.command);
        cmd.args(&config.args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        for env in &config.env {
            if let Some((k, v)) = env.split_once('=') {
                cmd.env(k, v);
            }
        }

        let mut process = cmd
            .spawn()
            .with_context(|| format!("Failed to spawn agent '{}'", config.name))?;

        let mut stdin = process.stdin.take().context("No stdin")?;
        let stdout = process.stdout.take().context("No stdout")?;
        let stderr = process.stderr.take().context("No stderr")?;

        // Create channel for sending messages to agent stdin
        let (stdin_tx, mut stdin_rx) = tokio::sync::mpsc::channel::<String>(1024);

        // Task: pump messages from channel → agent stdin
        tokio::spawn(async move {
            while let Some(msg) = stdin_rx.recv().await {
                let line = format!("{}\n", msg);
                if let Err(e) = stdin.write_all(line.as_bytes()).await {
                    warn!("Failed to write to agent stdin: {e}");
                    break;
                }
            }
        });

        // Task: pump lines from agent stdout+stderr → broadcast channel (all clients)
        let events_tx = self.events_tx.clone();
        let agent_id = id.clone();
        tokio::spawn(async move {
            let mut stdout_buf = String::new();
            let mut stderr_buf = String::new();
            let mut stdout_reader = tokio::io::BufReader::new(stdout);
            let mut stderr_reader = tokio::io::BufReader::new(stderr);
            loop {
                tokio::select! {
                    n = stdout_reader.read_line(&mut stdout_buf) => {
                        match n {
                            Ok(0) => break,
                            Ok(_) => {
                                let trimmed = stdout_buf.trim();
                                if !trimmed.is_empty() {
                                    broadcast_line(&events_tx, &agent_id, trimmed);
                                }
                                stdout_buf.clear();
                            }
                            Err(e) => {
                                warn!("Failed to read from agent stdout: {e}");
                                break;
                            }
                        }
                    }
                    n = stderr_reader.read_line(&mut stderr_buf) => {
                        match n {
                            Ok(0) => break,
                            Ok(_) => {
                                let trimmed = stderr_buf.trim();
                                if !trimmed.is_empty() {
                                    broadcast_line(&events_tx, &agent_id, trimmed);
                                }
                                stderr_buf.clear();
                            }
                            Err(e) => {
                                warn!("Failed to read from agent stderr: {e}");
                                break;
                            }
                        }
                    }
                }
            }
        });

        let instance = AgentInstance {
            process,
            stdin_tx,
        };

        self.agents.lock().await.insert(id.clone(), instance);
        info!("Agent spawned: {} (id={})", config.name, id);
        Ok(id)
    }

    /// Get the stdin sender for an agent.
    pub async fn get_stdin(&self, agent_id: &str) -> Option<tokio::sync::mpsc::Sender<String>> {
        self.agents.lock().await.get(agent_id).map(|a| a.stdin_tx.clone())
    }

    /// Kill an agent process.
    pub async fn kill(&self, agent_id: &str) {
        if let Some(mut instance) = self.agents.lock().await.remove(agent_id) {
            info!("Killing agent {}", agent_id);
            let _ = instance.process.kill().await;
            let _ = instance.process.wait().await;
        }
    }

    /// List all running agents.
    pub async fn list(&self) -> Vec<String> {
        self.agents.lock().await.keys().cloned().collect()
    }
}

/// Broadcast a single line from agent output to all connected clients.
fn broadcast_line(
    events_tx: &broadcast::Sender<String>,
    agent_id: &str,
    line: &str,
) {
    let notification = serde_json::json!({
        "method": "acp-notification",
        "params": {
            "agentId": agent_id,
            "message": line,
        }
    });
    if let Ok(json) = serde_json::to_string(&notification) {
        let _ = events_tx.send(json);
    }
}
