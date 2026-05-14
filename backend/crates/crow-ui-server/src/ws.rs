//! WebSocket server — Axum + embedded static frontend.

use std::io::Write;
use std::sync::Arc;

use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, Router},
    Json,
};
use mime_guess::from_path;
use crow_ui_terminal::TerminalEvent;
use rust_embed::RustEmbed;
use serde_json::Value;
use tokio::sync::{broadcast, Mutex};

use agent_client_protocol_schema as acp;
use crate::acp_session::SessionEvent;
use crate::handlers;
use crate::router::{WsError, WsNotification, WsRequest, WsResponse};
use crate::state::AppState;

/// Shared state wrapped for Axum extraction.
pub type App = Arc<Mutex<AppState>>;

/// Embedded frontend assets (built by Vite into target/frontend)
#[derive(RustEmbed)]
#[folder = "../../../target/frontend"]
struct Assets;

pub async fn run_server(app: App, port: u16) {
    let router = Router::new()
        .route("/ws", get(ws_handler))
        .route("/ws/acp", get(acp_ws_handler))
        .route("/api/acp/sessions", post(create_session_handler))
        .route("/api/acp/sessions/:session_id/prompt", post(prompt_session_handler))
        .route("/api/acp/sessions/:session_id/cancel", post(cancel_session_handler))
        .with_state(app)
        // Fallback: serve embedded frontend files
        .fallback(get(serve_embedded));

    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("failed to bind");

    // Get the actual bound address (resolves port 0 to actual OS-assigned port)
    let actual_addr = listener.local_addr().expect("failed to get local addr");

    // Print readiness marker to stdout for Electron parent process
    // (must use println! not tracing, since tracing goes to stderr)
    println!("__crow_ui_SERVER_READY__ port={}", actual_addr.port());
    let _ = std::io::stdout().flush();

    tracing::info!("Server listening on http://{actual_addr}");
    tracing::info!("WebSocket at ws://{actual_addr}/ws");

    axum::serve(listener, router).await.expect("server failed");
}

async fn ws_handler(ws: WebSocketUpgrade, State(app): State<App>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, app))
}

async fn acp_ws_handler(ws: WebSocketUpgrade, State(app): State<App>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_acp_socket(socket, app))
}

/// App control WebSocket — settings, files, terminals, worktree, etc.
/// Does NOT carry raw ACP protocol traffic.
async fn handle_socket(mut socket: WebSocket, app: App) {
    tracing::info!("WebSocket client connected (app control)");

    // Subscribe to terminal event broadcasts
    let mut event_rx = {
        let state = app.lock().await;
        state.terminal_events_tx.subscribe()
    };

    // Subscribe to ACP terminal event broadcasts (for inline terminals in chat UI)
    let mut acp_term_rx = {
        let state = app.lock().await;
        state.agents.terminals.subscribe_events()
    };

    // Subscribe to worktree file change broadcasts
    let mut worktree_rx = {
        let state = app.lock().await;
        state.worktree_events_tx.subscribe()
    };

    // Subscribe to settings change broadcasts
    let mut settings_rx = {
        let state = app.lock().await;
        state.settings_events_tx.subscribe()
    };

    // Subscribe to ACP command broadcasts (backend → frontend control)
    let mut acp_cmd_rx = {
        let state = app.lock().await;
        state.acp_cmd_tx.subscribe()
    };

    // Subscribe to backend ACP session events (session updates → frontend)
    let mut acp_session_rx = {
        let state = app.lock().await;
        state.acp_session_events_tx.subscribe()
    };

    loop {
        tokio::select! {
            // Incoming WebSocket message
            msg = socket.recv() => {
                let msg = match msg {
                    Some(Ok(m)) => m,
                    Some(Err(e)) => {
                        tracing::warn!("WebSocket error: {e}");
                        break;
                    }
                    None => {
                        tracing::info!("WebSocket client disconnected");
                        break;
                    }
                };

                match msg {
                    Message::Text(text) => {
                        let result = handle_message(&text, &app).await;
                        let response = serde_json::to_string(&result).unwrap_or_else(|_| {
                            r#"{"id":0,"error":"failed to serialize response"}"#.into()
                        });
                        if let Err(e) = socket.send(Message::Text(response)).await {
                            tracing::warn!("Failed to send response: {e}");
                            break;
                        }
                    }
                    Message::Close(_) => {
                        tracing::info!("WebSocket client disconnected");
                        break;
                    }
                    _ => {}
                }
            }
            // Terminal event from broadcast
            event = event_rx.recv() => {
                match event {
                    Ok(json) => {
                        if let Err(e) = socket.send(Message::Text(json)).await {
                            tracing::warn!("Failed to push terminal event: {e}");
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // Dropped events — continue
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        break;
                    }
                }
            }
            // ACP terminal event from broadcast
            acp_term_event = acp_term_rx.recv() => {
                match acp_term_event {
                    Ok(event) => {
                        let notification = match event {
                            crow_ui_acp::terminals::AcpTerminalEvent::Data { terminal_id, data } => WsNotification {
                                method: "acp-terminal-data".into(),
                                params: serde_json::json!({ "terminalId": terminal_id, "data": data }),
                            },
                            crow_ui_acp::terminals::AcpTerminalEvent::Exit { terminal_id, exit_code, signal } => WsNotification {
                                method: "acp-terminal-exit".into(),
                                params: serde_json::json!({ "terminalId": terminal_id, "exitCode": exit_code, "signal": signal }),
                            },
                        };
                        if let Ok(json) = serde_json::to_string(&notification) {
                            if let Err(e) = socket.send(Message::Text(json)).await {
                                tracing::warn!("Failed to push ACP terminal event: {e}");
                                break;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => {
                        break;
                    }
                }
            }
            // Worktree file change event from broadcast
            worktree_event = worktree_rx.recv() => {
                match worktree_event {
                    Ok(json) => {
                        // Update document model if file is open — keeps backend model in sync
                        // with external changes (e.g. MCP edit tool writing directly to disk)
                        if let Ok(event) = serde_json::from_str::<Value>(&json) {
                            if event["method"].as_str() == Some("worktree-file-changed")
                                || event["method"].as_str() == Some("worktree-file-created")
                            {
                                if let (Some(path), Some(new_content)) = (
                                    event["params"]["path"].as_str(),
                                    event["params"]["new_content"].as_str(),
                                ) {
                                    {
                                        let state = app.lock().await;
                                        let mut doc_entry = state.documents.get_mut(path);
                                        if let Some(ref mut entry) = doc_entry {
                                            let model = entry.value_mut();
                                            let line_count = model.line_count();
                                            if line_count == 0 {
                                                let edit = crow_ui_text::EditOperation::insert(
                                                    crow_ui_text::Position::new(0, 0),
                                                    new_content.to_string(),
                                                );
                                                model.apply_edit(&edit);
                                            } else {
                                                let last_line = line_count - 1;
                                                let last_col = model.buffer.get_line_length(last_line);
                                                let edit = crow_ui_text::EditOperation::replace(
                                                    crow_ui_text::Range::new(
                                                        crow_ui_text::Position::new(0, 0),
                                                        crow_ui_text::Position::new(last_line, last_col),
                                                    ),
                                                    new_content.to_string(),
                                                );
                                                model.apply_edit(&edit);
                                            }
                                            model.mark_saved();
                                        }
                                    }
                                }
                            }
                        }

                        if let Err(e) = socket.send(Message::Text(json)).await {
                            tracing::warn!("Failed to push worktree event: {e}");
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => {
                        break;
                    }
                }
            }
            // Settings change event from broadcast
            settings_event = settings_rx.recv() => {
                match settings_event {
                    Ok(key) => {
                        let notification = WsNotification {
                            method: "settings-changed".into(),
                            params: serde_json::json!({ "key": key }),
                        };
                        if let Ok(json) = serde_json::to_string(&notification) {
                            if let Err(e) = socket.send(Message::Text(json)).await {
                                tracing::warn!("Failed to push settings event: {e}");
                                break;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => {
                        break;
                    }
                }
            }
            // ACP command from broadcast (backend → frontend)
            acp_cmd = acp_cmd_rx.recv() => {
                match acp_cmd {
                    Ok(json) => {
                        if let Err(e) = socket.send(Message::Text(json)).await {
                            tracing::warn!("Failed to push ACP command: {e}");
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => {
                        break;
                    }
                }
            }
            // Backend ACP session event → frontend
            acp_session_event = acp_session_rx.recv() => {
                match acp_session_event {
                    Ok(SessionEvent::Update { session_id, update }) => {
                        let notification = WsNotification {
                            method: "acp-session-event".into(),
                            params: serde_json::json!({
                                "sessionId": session_id,
                                "update": update,
                            }),
                        };
                        if let Ok(json) = serde_json::to_string(&notification) {
                            if let Err(e) = socket.send(Message::Text(json)).await {
                                tracing::warn!("Failed to push ACP session event: {e}");
                                break;
                            }
                        }
                    }
                    Ok(SessionEvent::Disconnected { session_id }) => {
                        let notification = WsNotification {
                            method: "acp-session-disconnected".into(),
                            params: serde_json::json!({ "sessionId": session_id }),
                        };
                        if let Ok(json) = serde_json::to_string(&notification) {
                            if let Err(e) = socket.send(Message::Text(json)).await {
                                tracing::warn!("Failed to push ACP disconnect: {e}");
                                break;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => {
                        break;
                    }
                }
            }
        }
    }
}

/// ACP protocol WebSocket — dumb pipe between agent and frontend client.
/// Only carries ACP spawn/relay/kill and raw agent stdout events.
async fn handle_acp_socket(mut socket: WebSocket, app: App) {
    tracing::info!("WebSocket client connected (ACP protocol)");

    // Subscribe to ACP agent event broadcasts (raw agent stdout)
    let mut acp_rx = {
        let state = app.lock().await;
        state.agents.events_tx.subscribe()
    };

    loop {
        tokio::select! {
            // Incoming WebSocket message from frontend AcpClient
            msg = socket.recv() => {
                let msg = match msg {
                    Some(Ok(m)) => m,
                    Some(Err(e)) => {
                        tracing::warn!("ACP WebSocket error: {e}");
                        break;
                    }
                    None => {
                        tracing::info!("ACP WebSocket client disconnected");
                        break;
                    }
                };

                match msg {
                    Message::Text(text) => {
                        let result = handle_acp_message(&text, &app).await;
                        let response = serde_json::to_string(&result).unwrap_or_else(|_| {
                            r#"{"id":0,"error":"failed to serialize response"}"#.into()
                        });
                        if let Err(e) = socket.send(Message::Text(response)).await {
                            tracing::warn!("Failed to send ACP response: {e}");
                            break;
                        }
                    }
                    Message::Close(_) => {
                        tracing::info!("ACP WebSocket client disconnected");
                        break;
                    }
                    _ => {}
                }
            }
            // ACP agent event from broadcast (raw agent stdout → frontend)
            acp_event = acp_rx.recv() => {
                match acp_event {
                    Ok(json) => {
                        if let Err(e) = socket.send(Message::Text(json)).await {
                            tracing::warn!("Failed to push ACP event: {e}");
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // Dropped events — continue
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        break;
                    }
                }
            }
        }
    }
}

async fn handle_acp_message(text: &str, app: &App) -> Value {
    let request: WsRequest = match serde_json::from_str(text) {
        Ok(r) => r,
        Err(e) => {
            return serde_json::to_value(WsError {
                id: 0,
                error: format!("parse error: {e}"),
            })
            .unwrap_or_default();
        }
    };

    tracing::debug!("ACP request: id={} method={}", request.id, request.method);

    let state = app.lock().await;

    let result: Result<Value, String> = match request.method.as_str() {
        // ACP agent lifecycle
        "acp_spawn" => match serde_json::from_value::<crate::protocol::AcpSpawnRequest>(request.params) {
            Ok(req) => handlers::handle_acp_spawn(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "acp_relay" => match serde_json::from_value::<crate::protocol::AcpRelayRequest>(request.params) {
            Ok(req) => handlers::handle_acp_relay(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "acp_send" => match serde_json::from_value::<crate::protocol::AcpSendRequest>(request.params) {
            Ok(req) => handlers::handle_acp_send(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "acp_kill" => match serde_json::from_value::<crate::protocol::AcpKillRequest>(request.params) {
            Ok(req) => handlers::handle_acp_kill(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "acp_read_file" => match serde_json::from_value::<crate::protocol::AcpReadFileRequest>(request.params) {
            Ok(req) => handlers::handle_acp_read_file(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "acp_write_file" => match serde_json::from_value::<crate::protocol::AcpWriteFileRequest>(request.params) {
            Ok(req) => handlers::handle_acp_write_file(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },

        // ACP terminal methods
        "acp_create_terminal" => match serde_json::from_value::<crate::protocol::AcpCreateTerminalRequest>(request.params) {
            Ok(req) => handlers::handle_acp_create_terminal(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "acp_terminal_output" => match serde_json::from_value::<crate::protocol::AcpTerminalOutputRequest>(request.params) {
            Ok(req) => handlers::handle_acp_terminal_output(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "acp_wait_for_terminal_exit" => match serde_json::from_value::<crate::protocol::AcpWaitForTerminalExitRequest>(request.params) {
            Ok(req) => handlers::handle_acp_wait_for_terminal_exit(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "acp_kill_terminal" => match serde_json::from_value::<crate::protocol::AcpKillTerminalRequest>(request.params) {
            Ok(req) => handlers::handle_acp_kill_terminal(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "acp_release_terminal" => match serde_json::from_value::<crate::protocol::AcpReleaseTerminalRequest>(request.params) {
            Ok(req) => handlers::handle_acp_release_terminal(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "acp_terminal_write_input" => match serde_json::from_value::<crate::protocol::AcpTerminalWriteInputRequest>(request.params) {
            Ok(req) => handlers::handle_acp_terminal_write_input(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "acp_terminal_resize" => match serde_json::from_value::<crate::protocol::AcpTerminalResizeRequest>(request.params) {
            Ok(req) => handlers::handle_acp_terminal_resize(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },

        unknown => Err(format!("unknown ACP method: {unknown}")),
    };

    drop(state);

    match result {
        Ok(value) => {
            serde_json::to_value(WsResponse { id: request.id, result: value }).unwrap_or_default()
        }
        Err(error) => {
            serde_json::to_value(WsError { id: request.id, error }).unwrap_or_default()
        }
    }
}

async fn handle_message(text: &str, app: &App) -> Value {
    let request: WsRequest = match serde_json::from_str(text) {
        Ok(r) => r,
        Err(e) => {
            return serde_json::to_value(WsError {
                id: 0,
                error: format!("parse error: {e}"),
            })
            .unwrap_or_default();
        }
    };

    tracing::debug!("Received request: id={} method={}", request.id, request.method);

    let state = app.lock().await;

    let result: Result<Value, String> = match request.method.as_str() {
        // Document methods (sync, use AppState)
        "document_open" => serde_json::from_value::<crate::protocol::DocumentOpenRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_document_open(&state, req).map(|r| serde_json::to_value(r).unwrap_or_default())),
        "document_close" => serde_json::from_value::<crate::protocol::DocumentCloseRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_document_close(&state, req)),
        "document_edit" => serde_json::from_value::<crate::protocol::DocumentEditRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_document_edit(&state, req)),
        "document_set_content" => serde_json::from_value::<crate::protocol::DocumentSetContentRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_document_set_content(&state, req)),
        "document_get_content" => serde_json::from_value::<crate::protocol::DocumentGetContentRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_document_get_content(&state, req).map(|r| serde_json::to_value(r).unwrap_or_default())),
        "document_get_info" => serde_json::from_value::<crate::protocol::DocumentGetInfoRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_document_get_info(&state, req).map(|r| serde_json::to_value(r).unwrap_or_default())),

        // Document methods (async, use AppState + IO)
        "document_save" => match serde_json::from_value::<crate::protocol::DocumentSaveRequest>(request.params) {
            Ok(req) => handlers::handle_document_save(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },

        // Filesystem methods (async, no state needed)
        "read_dir" => match serde_json::from_value::<crate::protocol::ReadDirRequest>(request.params) {
            Ok(req) => handlers::handle_read_dir(req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "read_file" => match serde_json::from_value::<crate::protocol::ReadFileRequest>(request.params) {
            Ok(req) => handlers::handle_read_file(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "write_file" => match serde_json::from_value::<crate::protocol::WriteFileRequest>(request.params) {
            Ok(req) => handlers::handle_write_file(&state, req).await,
            Err(e) => Err(e.to_string()),
        },
        "exists" => match serde_json::from_value::<crate::protocol::ExistsRequest>(request.params) {
            Ok(req) => handlers::handle_exists(req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "remove" => match serde_json::from_value::<crate::protocol::RemoveRequest>(request.params) {
            Ok(req) => handlers::handle_remove(req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "rename" => match serde_json::from_value::<crate::protocol::RenameRequest>(request.params) {
            Ok(req) => handlers::handle_rename(req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "stat" => match serde_json::from_value::<crate::protocol::StatRequest>(request.params) {
            Ok(req) => handlers::handle_stat(req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "create_file" => match serde_json::from_value::<crate::protocol::CreateFileRequest>(request.params) {
            Ok(req) => handlers::handle_create_file(req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "create_dir" => match serde_json::from_value::<crate::protocol::CreateDirRequest>(request.params) {
            Ok(req) => handlers::handle_create_dir(req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },

        // Workspace methods
        "get_current_workspace" => serde_json::from_value::<crate::protocol::GetCurrentWorkspaceRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_get_current_workspace(&state, req).map(|r| serde_json::to_value(r).unwrap_or_default())),
        "workspace_open" => serde_json::from_value::<crate::protocol::WorkspaceOpenRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_workspace_open(&state, req).map(|r| serde_json::to_value(r).unwrap_or_default())),
        "workspace_expand" => serde_json::from_value::<crate::protocol::WorkspaceExpandRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_workspace_expand(&state, req).map(|r| serde_json::to_value(r).unwrap_or_default())),

        // Terminal methods (sync, use TerminalManager in AppState)
        "terminal_spawn" => serde_json::from_value::<crate::protocol::TerminalSpawnRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_terminal_spawn(&state, req).map(|r| serde_json::to_value(r).unwrap_or_default())),
        "terminal_write" => serde_json::from_value::<crate::protocol::TerminalWriteRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_terminal_write(&state, req)),
        "terminal_resize" => serde_json::from_value::<crate::protocol::TerminalResizeRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_terminal_resize(&state, req)),
        "terminal_kill" => serde_json::from_value::<crate::protocol::TerminalKillRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_terminal_kill(&state, req)),
        "terminal_info" => serde_json::from_value::<crate::protocol::TerminalInfoRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_terminal_info(&state, req).map(|r| serde_json::to_value(r).unwrap_or_default())),
        "get_default_shell" => serde_json::from_value::<crate::protocol::GetDefaultShellRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_get_default_shell(&state, req).map(|r| serde_json::to_value(r).unwrap_or_default())),
        "get_available_shells" => serde_json::from_value::<crate::protocol::GetAvailableShellsRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_get_available_shells(&state, req).map(|r| serde_json::to_value(r).unwrap_or_default())),

        // Worktree state methods
        "get_file_before_content" => match serde_json::from_value::<crate::protocol::GetFileBeforeContentRequest>(request.params) {
            Ok(req) => handlers::handle_get_file_before_content(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "get_file_change" => match serde_json::from_value::<crate::protocol::GetFileChangeRequest>(request.params) {
            Ok(req) => handlers::handle_get_file_change(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },

        // Config methods
        "get_config_path" => serde_json::from_value::<crate::protocol::GetConfigPathRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_get_config_path(&state, req).map(|r| serde_json::to_value(r).unwrap_or_default())),

        // Session state methods (SQLite-backed)
        "get_recent_workspaces" => serde_json::from_value::<crate::protocol::GetRecentWorkspacesRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_get_recent_workspaces(&state, req).map(|r| serde_json::to_value(r).unwrap_or_default())),
        "add_recent_workspace" => serde_json::from_value::<crate::protocol::AddRecentWorkspaceRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_add_recent_workspace(&state, req).map(|r| serde_json::to_value(r).unwrap_or_default())),

        // Workspace layout methods (SQLite-backed)
        "get_workspace_layout" => serde_json::from_value::<crate::protocol::GetWorkspaceLayoutRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_get_workspace_layout(&state, req).map(|r| serde_json::to_value(r).unwrap_or_default())),
        "save_workspace_layout" => serde_json::from_value::<crate::protocol::SaveWorkspaceLayoutRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_save_workspace_layout(&state, req).map(|r| serde_json::to_value(r).unwrap_or_default())),

        // Explorer state methods (SQLite-backed)
        "get_explorer_state" => serde_json::from_value::<crate::protocol::GetExplorerStateRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_get_explorer_state(&state, req).map(|r| serde_json::to_value(r).unwrap_or_default())),
        "save_explorer_state" => serde_json::from_value::<crate::protocol::SaveExplorerStateRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_save_explorer_state(&state, req).map(|r| serde_json::to_value(r).unwrap_or_default())),

        // Tile state methods (SQLite-backed)
        "get_tile_states" => serde_json::from_value::<crate::protocol::GetTileStatesRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_get_tile_states(&state, req).map(|r| serde_json::to_value(r).unwrap_or_default())),
        "save_tile_state" => serde_json::from_value::<crate::protocol::SaveTileStateRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_save_tile_state(&state, req).map(|r| serde_json::to_value(r).unwrap_or_default())),
        "delete_tile_state" => serde_json::from_value::<crate::protocol::DeleteTileStateRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_delete_tile_state(&state, req).map(|r| serde_json::to_value(r).unwrap_or_default())),
        "clear_tile_states" => serde_json::from_value::<crate::protocol::ClearTileStatesRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_clear_tile_states(&state, req).map(|r| serde_json::to_value(r).unwrap_or_default())),

        // Settings methods
        "get_all_settings" => serde_json::from_value::<crate::protocol::GetAllSettingsRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_get_all_settings(&state, req).map(|r| serde_json::to_value(r).unwrap_or_default())),
        "get_setting" => serde_json::from_value::<crate::protocol::GetSettingRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_get_setting(&state, req).map(|r| serde_json::to_value(r).unwrap_or_default())),
        "update_setting" => serde_json::from_value::<crate::protocol::UpdateSettingRequest>(request.params)
            .map_err(|e| e.to_string())
            .and_then(|req| handlers::handle_update_setting(&state, req).map(|r| serde_json::to_value(r).unwrap_or_default())),

        // ACP methods
        "acp_relay" => match serde_json::from_value::<crate::protocol::AcpRelayRequest>(request.params) {
            Ok(req) => handlers::handle_acp_relay(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "acp_spawn" => match serde_json::from_value::<crate::protocol::AcpSpawnRequest>(request.params) {
            Ok(req) => handlers::handle_acp_spawn(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "acp_send" => match serde_json::from_value::<crate::protocol::AcpSendRequest>(request.params) {
            Ok(req) => handlers::handle_acp_send(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "acp_kill" => match serde_json::from_value::<crate::protocol::AcpKillRequest>(request.params) {
            Ok(req) => handlers::handle_acp_kill(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "acp_read_file" => match serde_json::from_value::<crate::protocol::AcpReadFileRequest>(request.params) {
            Ok(req) => handlers::handle_acp_read_file(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "acp_write_file" => match serde_json::from_value::<crate::protocol::AcpWriteFileRequest>(request.params) {
            Ok(req) => handlers::handle_acp_write_file(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "acp_create_terminal" => match serde_json::from_value::<crate::protocol::AcpCreateTerminalRequest>(request.params) {
            Ok(req) => handlers::handle_acp_create_terminal(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "acp_terminal_output" => match serde_json::from_value::<crate::protocol::AcpTerminalOutputRequest>(request.params) {
            Ok(req) => handlers::handle_acp_terminal_output(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "acp_wait_for_terminal_exit" => match serde_json::from_value::<crate::protocol::AcpWaitForTerminalExitRequest>(request.params) {
            Ok(req) => handlers::handle_acp_wait_for_terminal_exit(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "acp_kill_terminal" => match serde_json::from_value::<crate::protocol::AcpKillTerminalRequest>(request.params) {
            Ok(req) => handlers::handle_acp_kill_terminal(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "acp_release_terminal" => match serde_json::from_value::<crate::protocol::AcpReleaseTerminalRequest>(request.params) {
            Ok(req) => handlers::handle_acp_release_terminal(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "acp_terminal_write_input" => match serde_json::from_value::<crate::protocol::AcpTerminalWriteInputRequest>(request.params) {
            Ok(req) => handlers::handle_acp_terminal_write_input(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },
        "acp_terminal_resize" => match serde_json::from_value::<crate::protocol::AcpTerminalResizeRequest>(request.params) {
            Ok(req) => handlers::handle_acp_terminal_resize(&state, req).await.map(|r| serde_json::to_value(r).unwrap_or_default()),
            Err(e) => Err(e.to_string()),
        },

        // ACP control reports (frontend → backend)
        "acp_report_session_created" => {
            let request_id = request.params.get("requestId").and_then(|v| v.as_str()).unwrap_or("");
            let result = request.params.get("result").cloned().unwrap_or(serde_json::Value::Null);
            if let Some((_, tx)) = state.acp_pending.remove(request_id) {
                let _ = tx.send(result);
            }
            Ok(serde_json::json!({ "ok": true }))
        }

        unknown => Err(format!("unknown method: {unknown}")),
    };

    drop(state);

    match result {
        Ok(value) => {
            tracing::debug!("Success for id={}", request.id);
            serde_json::to_value(WsResponse { id: request.id, result: value }).unwrap_or_default()
        }
        Err(error) => {
            tracing::warn!("Error for id={}: {}", request.id, error);
            serde_json::to_value(WsError { id: request.id, error }).unwrap_or_default()
        }
    }
}

/// HTTP handler: POST /api/acp/sessions
/// Creates a new ACP session synchronously.
/// Broadcasts acp-command-new-session to frontend and waits for acp-report-session-created.
async fn create_session_handler(
    State(app): State<App>,
    axum::Json(body): axum::Json<Value>,
) -> impl IntoResponse {
    let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("agent").to_string();
    let command = body.get("command").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let args: Vec<String> = body.get("args")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    let env: Vec<String> = body.get("env")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    let cwd = body.get("cwd").and_then(|v| v.as_str()).unwrap_or(".").to_string();

    let state = app.lock().await;
    let forward_tx = state.acp_session_events_tx.clone();

    match state.acp_sessions.create_session(name, command, args, env, cwd, forward_tx).await {
        Ok(session) => {
            (StatusCode::OK, Json(serde_json::json!({
                "sessionId": session.session_id,
                "agentId": session.agent_id,
            }))).into_response()
        }
        Err(e) => {
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                "error": format!("Failed to create session: {e}")
            }))).into_response()
        }
    }
}

/// HTTP handler: POST /api/acp/sessions/:session_id/prompt
/// Sends prompt to backend-owned ACP session.
async fn prompt_session_handler(
    Path(session_id): Path<String>,
    State(app): State<App>,
    axum::Json(body): axum::Json<Value>,
) -> impl IntoResponse {
    let state = app.lock().await;
    let session = match state.acp_sessions.get_session(&session_id).await {
        Some(s) => s,
        None => {
            return (StatusCode::NOT_FOUND, Json(serde_json::json!({
                "error": format!("Session not found: {session_id}")
            }))).into_response();
        }
    };

    let blocks: Vec<acp::ContentBlock> = match body.get("blocks") {
        Some(arr) => match serde_json::from_value(arr.clone()) {
            Ok(b) => b,
            Err(e) => {
                return (StatusCode::BAD_REQUEST, Json(serde_json::json!({
                    "error": format!("Invalid blocks: {e}")
                }))).into_response();
            }
        },
        None => vec![],
    };

    drop(state);

    match session.prompt(blocks).await {
        Ok(()) => (StatusCode::ACCEPTED, Json(serde_json::json!({ "status": "prompted" }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
            "error": format!("Prompt failed: {e}")
        }))).into_response(),
    }
}

/// HTTP handler: POST /api/acp/sessions/:session_id/cancel
/// Cancels current prompt turn on backend-owned ACP session.
async fn cancel_session_handler(
    Path(session_id): Path<String>,
    State(app): State<App>,
) -> impl IntoResponse {
    let state = app.lock().await;
    let session = match state.acp_sessions.get_session(&session_id).await {
        Some(s) => s,
        None => {
            return (StatusCode::NOT_FOUND, Json(serde_json::json!({
                "error": format!("Session not found: {session_id}")
            }))).into_response();
        }
    };

    drop(state);

    match session.cancel().await {
        Ok(()) => (StatusCode::ACCEPTED, Json(serde_json::json!({ "status": "cancelled" }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
            "error": format!("Cancel failed: {e}")
        }))).into_response(),
    }
}

/// Serve embedded frontend assets.
async fn serve_embedded(uri: axum::http::Uri) -> Response<Body> {
    let mut path = uri.path().trim_start_matches('/').to_string();

    if path.is_empty() {
        path = "index.html".to_string();
    }

    // Handle SPA routes: if path has no extension and isn't a known asset, serve index.html
    let has_extension = path.contains('.');
    let is_known_asset = path.starts_with("assets/") || path == "index.html" || path == "vite.svg" || path == "tauri.svg";

    if !has_extension && !is_known_asset {
        path = "index.html".to_string();
    }

    match Assets::get(&path) {
        Some(file) => {
            let mime = from_path(&path).first_or_octet_stream();
            let mut headers = HeaderMap::new();
            headers.insert(
                axum::http::header::CONTENT_TYPE,
                HeaderValue::from_str(mime.as_ref()).unwrap_or(HeaderValue::from_static("application/octet-stream")),
            );
            // Cache static assets aggressively (except index.html)
            if path != "index.html" {
                headers.insert(
                    axum::http::header::CACHE_CONTROL,
                    HeaderValue::from_static("public, max-age=31536000, immutable"),
                );
            }
            (headers, file.data).into_response()
        }
        None => {
            // SPA fallback: return index.html for unknown routes
            match Assets::get("index.html") {
                Some(file) => {
                    let mut headers = HeaderMap::new();
                    headers.insert(
                        axum::http::header::CONTENT_TYPE,
                        HeaderValue::from_static("text/html; charset=utf-8"),
                    );
                    (headers, file.data).into_response()
                }
                None => StatusCode::NOT_FOUND.into_response(),
            }
        }
    }
}

/// Background task: reads from crossbeam channel, broadcasts as JSON to all clients.
pub async fn terminal_event_bridge(
    rx: crossbeam::channel::Receiver<TerminalEvent>,
    tx: broadcast::Sender<String>,
) {
    loop {
        match rx.recv() {
            Ok(event) => {
                let notification = match event {
                    TerminalEvent::Data { id, text } => WsNotification {
                        method: "terminal-data".into(),
                        params: serde_json::json!({ "id": id.0, "data": text }),
                    },
                    TerminalEvent::Exit { id, exit_code } => WsNotification {
                        method: "terminal-exit".into(),
                        params: serde_json::json!({ "id": id.0, "exit_code": exit_code }),
                    },
                    TerminalEvent::Started { id, shell, pid, cwd } => WsNotification {
                        method: "terminal-started".into(),
                        params: serde_json::json!({ "id": id.0, "shell": shell, "pid": pid, "cwd": cwd }),
                    },
                };
                if let Ok(json) = serde_json::to_string(&notification) {
                    // Send to all subscribers; ignore if no subscribers
                    let _ = tx.send(json);
                }
            }
            Err(crossbeam::channel::RecvError) => break,
        }
    }
}
