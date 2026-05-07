//! ACP terminal management — spawn agent-requested terminals and track output.
//!
//! Terminals are backed by real PTY processes (portable-pty) so they produce
//! proper ANSI escape sequences that xterm.js can render.
//! Terminals are kept until explicitly released via `release_terminal`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use murder_terminal::{PtyProcess, PtySpawnConfig, TerminalSize};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tracing::{info, warn};

const DEFAULT_OUTPUT_LIMIT: usize = 64 * 1024;
const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;

/// Events broadcast when ACP terminal state changes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AcpTerminalEvent {
    Data { terminal_id: String, data: String },
    Exit {
        terminal_id: String,
        exit_code: Option<i32>,
        signal: Option<String>,
    },
}

pub struct AcpTerminal {
    pub id: String,
    pub command: String,
    pub cwd: Option<String>,
    pub pty: Option<PtyProcess>,
    pub output: String,
    pub output_byte_limit: usize,
    pub exited: bool,
    pub exit_code: Option<i32>,
    pub exit_signal: Option<String>,
    pub event_tx: tokio::sync::broadcast::Sender<AcpTerminalEvent>,
}

impl AcpTerminal {
    pub fn truncated_output(&self) -> (String, bool) {
        let truncated = self.output.len() > self.output_byte_limit;
        let output = if truncated {
            let mut end = self.output_byte_limit.min(self.output.len());
            while end > 0 && !self.output.is_char_boundary(end) {
                end -= 1;
            }
            if let Some(last_nl) = self.output[..end].rfind('\n') {
                self.output[..last_nl + 1].to_string()
            } else {
                self.output[..end].to_string()
            }
        } else {
            self.output.clone()
        };
        (output, truncated)
    }

    /// Subscribe to terminal events.
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<AcpTerminalEvent> {
        self.event_tx.subscribe()
    }

    fn notify(&self, event: AcpTerminalEvent) {
        let _ = self.event_tx.send(event);
    }
}

struct Inner {
    terminals: Mutex<HashMap<String, Arc<Mutex<AcpTerminal>>>>,
    next_id: Mutex<u64>,
    /// Global broadcast for all ACP terminal events (cross-terminal).
    global_tx: tokio::sync::broadcast::Sender<AcpTerminalEvent>,
}

pub struct AcpTerminalManager {
    inner: Arc<Inner>,
}

impl AcpTerminalManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                terminals: Mutex::new(HashMap::new()),
                next_id: Mutex::new(1),
                global_tx: tokio::sync::broadcast::Sender::new(256),
            }),
        }
    }

    /// Subscribe to global ACP terminal events.
    pub fn subscribe_events(&self) -> tokio::sync::broadcast::Receiver<AcpTerminalEvent> {
        self.inner.global_tx.subscribe()
    }

    pub async fn create_terminal(
        &self,
        command: &str,
        args: &[String],
        env: &[(String, String)],
        cwd: Option<&str>,
        output_byte_limit: Option<usize>,
    ) -> Result<String> {
        let id = {
            let mut next = self.inner.next_id.lock().await;
            let id = format!("acp_term_{}", *next);
            *next += 1;
            id
        };

        info!("Creating ACP PTY terminal '{}' (id={}) in {:?}", command, id, cwd);

        // Build the command line: shell -c "command arg1 arg2 ..."
        // We use the system shell to execute the command in a real PTY
        let shell = murder_terminal::detect_default_shell();
        let cmd_str = if args.is_empty() {
            command.to_string()
        } else {
            format!("{} {}", command, args.join(" "))
        };

        let mut env_map = std::collections::HashMap::new();
        env_map.insert("PAGER".to_string(), "cat".to_string());
        env_map.insert("GIT_PAGER".to_string(), "cat".to_string());
        for (k, v) in env {
            env_map.insert(k.clone(), v.clone());
        }

        let size = TerminalSize {
            rows: DEFAULT_ROWS,
            cols: DEFAULT_COLS,
        };

        let mut config = PtySpawnConfig {
            shell: Some(shell),
            args: Some(vec!["-c".to_string(), cmd_str.clone()]),
            cwd: cwd.map(PathBuf::from),
            env: env_map,
            size,
        };

        let mut pty = PtyProcess::spawn(&config)
            .with_context(|| format!("Failed to spawn PTY for '{}'", command))?;

        let limit = output_byte_limit.unwrap_or(DEFAULT_OUTPUT_LIMIT);

        // Set up output callback
        let terminal_id = id.clone();
        let global_tx = self.inner.global_tx.clone();

        // We need to capture output and also forward it
        // Use the read_output polling approach instead of on_output
        // to avoid taking the output_rx

        let terminal = Arc::new(Mutex::new(AcpTerminal {
            id: id.clone(),
            command: command.to_string(),
            cwd: cwd.map(String::from),
            pty: Some(pty),
            output: String::new(),
            output_byte_limit: limit,
            exited: false,
            exit_code: None,
            exit_signal: None,
            event_tx: tokio::sync::broadcast::Sender::new(64),
        }));

        {
            let mut terminals = self.inner.terminals.lock().await;
            terminals.insert(id.clone(), terminal.clone());
        }

        // Spawn a task to poll the PTY output and detect exit
        let term_id = id.clone();
        let global_tx2 = global_tx.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;

                let exited = {
                    let term = terminal.lock().await;
                    if let Some(ref pty) = term.pty {
                        if let Ok(read_result) = pty.read_output(None) {
                            let mut output = String::new();
                            for chunk in &read_result.lines {
                                output.push_str(&chunk.text);
                            }

                            if !output.is_empty() {
                                drop(term); // release lock
                                let mut t = terminal.lock().await;
                                t.output.push_str(&output);

                                // Notify per-terminal
                                let _ = t.event_tx.send(AcpTerminalEvent::Data {
                                    terminal_id: term_id.clone(),
                                    data: output.clone(),
                                });
                                // Notify globally
                                let _ = global_tx2.send(AcpTerminalEvent::Data {
                                    terminal_id: term_id.clone(),
                                    data: output,
                                });
                            }

                            // Check if process exited
                            !read_result.is_alive
                        } else {
                            false
                        }
                    } else {
                        true
                    }
                };

                if exited {
                    let mut t = terminal.lock().await;
                    t.exited = true;
                    t.exit_code = t.pty.as_ref().and_then(|p| p.exit_code());
                    #[cfg(unix)]
                    {
                        t.exit_signal = None;
                    }
                    let exit_code = t.exit_code;
                    let exit_signal = t.exit_signal.clone();
                    drop(t);

                    let _ = terminal.lock().await.event_tx.send(AcpTerminalEvent::Exit {
                        terminal_id: term_id.clone(),
                        exit_code,
                        signal: exit_signal.clone(),
                    });
                    let _ = global_tx2.send(AcpTerminalEvent::Exit {
                        terminal_id: term_id.clone(),
                        exit_code,
                        signal: exit_signal,
                    });
                    break;
                }
            }

            // Terminal exited — kept until released
        });

        Ok(id)
    }

    pub async fn write_input(&self, id: &str, data: &str) -> Result<()> {
        let terminals = self.inner.terminals.lock().await;
        let term = terminals
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("Terminal not found: {}", id))?;
        let t = term.lock().await;
        if let Some(ref pty) = t.pty {
            pty.write_str(data).context("Failed to write to PTY")?;
        }
        Ok(())
    }

    pub async fn resize_terminal(&self, id: &str, rows: u16, cols: u16) -> Result<()> {
        let terminals = self.inner.terminals.lock().await;
        let term = terminals
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("Terminal not found: {}", id))?;
        let mut t = term.lock().await;
        if let Some(ref mut pty) = t.pty {
            pty.resize(TerminalSize { rows, cols })
                .context("Failed to resize PTY")?;
        }
        Ok(())
    }

    pub async fn terminal_output(&self, id: &str) -> Option<(String, bool)> {
        let terminals = self.inner.terminals.lock().await;
        let term = terminals.get(id)?;
        let t = term.lock().await;
        Some(t.truncated_output())
    }

    pub async fn terminal_info(&self, id: &str) -> Option<(bool, Option<i32>, Option<String>)> {
        let terminals = self.inner.terminals.lock().await;
        let term = terminals.get(id)?;
        let t = term.lock().await;
        Some((t.exited, t.exit_code, t.exit_signal.clone()))
    }

    pub async fn kill_terminal(&self, id: &str) -> bool {
        let terminals = self.inner.terminals.lock().await;
        if let Some(term) = terminals.get(id) {
            let mut t = term.lock().await;
            if !t.exited {
                if let Some(ref pty) = t.pty {
                    let _ = pty.kill_tree();
                }
                t.exited = true;
                t.exit_code = t.pty.as_ref().and_then(|p| p.exit_code());
            }
            true
        } else {
            false
        }
    }

    pub async fn release_terminal(&self, id: &str) -> bool {
        if let Some(term) = self.inner.terminals.lock().await.remove(id) {
            let t = term.lock().await;
            if let Some(ref pty) = t.pty {
                let _ = pty.kill_tree();
            }
            true
        } else {
            false
        }
    }
}
