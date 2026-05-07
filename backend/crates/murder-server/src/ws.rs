//! WebSocket server — Axum + embedded static frontend.

use std::io::Write;
use std::sync::Arc;

use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, Router},
};
use mime_guess::from_path;
use murder_terminal::TerminalEvent;
use rust_embed::RustEmbed;
use serde_json::Value;
use tokio::sync::{broadcast, Mutex};

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
    println!("__MURDER_SERVER_READY__ port={}", actual_addr.port());
    let _ = std::io::stdout().flush();
    
    tracing::info!("Server listening on http://{actual_addr}");
    tracing::info!("WebSocket at ws://{actual_addr}/ws");

    axum::serve(listener, router).await.expect("server failed");
}

async fn ws_handler(ws: WebSocketUpgrade, State(app): State<App>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, app))
}

async fn handle_socket(mut socket: WebSocket, app: App) {
    tracing::info!("WebSocket client connected");

    // Subscribe to terminal event broadcasts
    let mut event_rx = {
        let state = app.lock().await;
        state.terminal_events_tx.subscribe()
    };

    // Subscribe to ACP agent event broadcasts
    let mut acp_rx = {
        let state = app.lock().await;
        state.agents.events_tx.subscribe()
    };

    // Subscribe to ACP terminal event broadcasts
    let mut acp_term_rx = {
        let state = app.lock().await;
        state.agents.terminals.subscribe_events()
    };

    // Subscribe to worktree file change broadcasts
    let mut worktree_rx = {
        let state = app.lock().await;
        state.worktree_events_tx.subscribe()
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
            // ACP agent event from broadcast
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
            // ACP terminal event from broadcast
            acp_term_event = acp_term_rx.recv() => {
                match acp_term_event {
                    Ok(event) => {
                        let notification = match event {
                            murder_acp::terminals::AcpTerminalEvent::Data { terminal_id, data } => WsNotification {
                                method: "acp-terminal-data".into(),
                                params: serde_json::json!({ "terminalId": terminal_id, "data": data }),
                            },
                            murder_acp::terminals::AcpTerminalEvent::Exit { terminal_id, exit_code, signal } => WsNotification {
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
        "document_open" => handlers::handle_document_open(&state, &request.params),
        "document_close" => handlers::handle_document_close(&state, &request.params),
        "document_edit" => handlers::handle_document_edit(&state, &request.params),
        "document_set_content" => handlers::handle_document_set_content(&state, &request.params),
        "document_get_content" => handlers::handle_document_get_content(&state, &request.params),
        "document_get_info" => handlers::handle_document_get_info(&state, &request.params),

        // Document methods (async, use AppState + IO)
        "document_save" => handlers::handle_document_save(&state, &request.params).await,

        // Filesystem methods (async, no state needed)
        "read_dir" => handlers::handle_read_dir(&request.params).await,
        "read_file" => handlers::handle_read_file(&request.params).await,
        "write_file" => handlers::handle_write_file(&request.params).await,
        "exists" => handlers::handle_exists(&request.params).await,
        "mkdir" => handlers::handle_mkdir(&request.params).await,
        "remove" => handlers::handle_remove(&request.params).await,
        "rename" => handlers::handle_rename(&request.params).await,
        "stat" => handlers::handle_stat(&request.params).await,
        "create_file" => handlers::handle_create_file(&request.params).await,
        "create_dir" => handlers::handle_create_dir(&request.params).await,

        // Workspace methods
        "workspace_open" => handlers::handle_workspace_open(&state, &request.params),
        "workspace_expand" => handlers::handle_workspace_expand(&state, &request.params),

        // Terminal methods (sync, use TerminalManager in AppState)
        "terminal_spawn" => handlers::handle_terminal_spawn(&state, &request.params),
        "terminal_write" => handlers::handle_terminal_write(&state, &request.params),
        "terminal_resize" => handlers::handle_terminal_resize(&state, &request.params),
        "terminal_kill" => handlers::handle_terminal_kill(&state, &request.params),
        "terminal_info" => handlers::handle_terminal_info(&state, &request.params),
        "get_default_shell" => handlers::handle_get_default_shell(&state, &request.params),
        "get_available_shells" => handlers::handle_get_available_shells(&state, &request.params),

        // ACP methods
        "acp_spawn" => handlers::handle_acp_spawn(&state, &request.params).await,
        "acp_relay" => handlers::handle_acp_relay(&state, &request.params).await,
        "acp_send" => handlers::handle_acp_send(&state, &request.params).await,
        "acp_kill" => handlers::handle_acp_kill(&state, &request.params).await,
        "acp_read_file" => handlers::handle_acp_read_file(&state, &request.params).await,
        "acp_write_file" => handlers::handle_acp_write_file(&state, &request.params).await,

        // ACP terminal methods
        "acp_create_terminal" => handlers::handle_acp_create_terminal(&state, &request.params).await,
        "acp_terminal_output" => handlers::handle_acp_terminal_output(&state, &request.params).await,
        "acp_wait_for_terminal_exit" => handlers::handle_acp_wait_for_terminal_exit(&state, &request.params).await,
        "acp_kill_terminal" => handlers::handle_acp_kill_terminal(&state, &request.params).await,
        "acp_release_terminal" => handlers::handle_acp_release_terminal(&state, &request.params).await,
        "acp_terminal_write_input" => handlers::handle_acp_terminal_write_input(&state, &request.params).await,
        "acp_terminal_resize" => handlers::handle_acp_terminal_resize(&state, &request.params).await,

        // Worktree state methods
        "get_file_before_content" => handlers::handle_get_file_before_content(&state, &request.params).await,
        "get_file_change" => handlers::handle_get_file_change(&state, &request.params).await,

        // Config methods
        "get_config_path" => handlers::handle_get_config_path(&state, &request.params),

        // Session state methods (SQLite-backed)
        "get_recent_workspaces" => handlers::handle_get_recent_workspaces(&state, &request.params),
        "add_recent_workspace" => handlers::handle_add_recent_workspace(&state, &request.params),

        // Mosaic layout methods (SQLite-backed)
        "get_mosaic_layout" => handlers::handle_get_mosaic_layout(&state, &request.params),
        "save_mosaic_layout" => handlers::handle_save_mosaic_layout(&state, &request.params),

        // Explorer state methods (SQLite-backed)
        "get_explorer_state" => handlers::handle_get_explorer_state(&state, &request.params),
        "save_explorer_state" => handlers::handle_save_explorer_state(&state, &request.params),

        // Tile state methods (SQLite-backed)
        "get_tile_states" => handlers::handle_get_tile_states(&state, &request.params),
        "save_tile_state" => handlers::handle_save_tile_state(&state, &request.params),
        "delete_tile_state" => handlers::handle_delete_tile_state(&state, &request.params),
        "clear_tile_states" => handlers::handle_clear_tile_states(&state, &request.params),

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
