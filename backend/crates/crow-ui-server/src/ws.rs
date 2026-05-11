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
        "read_file" => handlers::handle_read_file(&state, &request.params).await,
        "write_file" => handlers::handle_write_file(&state, &request.params).await,
        "exists" => handlers::handle_exists(&request.params).await,
        "mkdir" => handlers::handle_mkdir(&request.params).await,
        "remove" => handlers::handle_remove(&request.params).await,
        "rename" => handlers::handle_rename(&request.params).await,
        "stat" => handlers::handle_stat(&request.params).await,
        "create_file" => handlers::handle_create_file(&request.params).await,
        "create_dir" => handlers::handle_create_dir(&request.params).await,

        // Workspace methods
        "get_current_workspace" => handlers::handle_get_current_workspace(&state, &request.params),
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

        // Worktree state methods
        "get_file_before_content" => handlers::handle_get_file_before_content(&state, &request.params).await,
        "get_file_change" => handlers::handle_get_file_change(&state, &request.params).await,

        // Config methods
        "get_config_path" => handlers::handle_get_config_path(&state, &request.params),

        // Session state methods (SQLite-backed)
        "get_recent_workspaces" => handlers::handle_get_recent_workspaces(&state, &request.params),
        "add_recent_workspace" => handlers::handle_add_recent_workspace(&state, &request.params),

        // Workspace layout methods (SQLite-backed)
        "get_workspace_layout" => handlers::handle_get_workspace_layout(&state, &request.params),
        "save_workspace_layout" => handlers::handle_save_workspace_layout(&state, &request.params),

        // Explorer state methods (SQLite-backed)
        "get_explorer_state" => handlers::handle_get_explorer_state(&state, &request.params),
        "save_explorer_state" => handlers::handle_save_explorer_state(&state, &request.params),

        // Tile state methods (SQLite-backed)
        "get_tile_states" => handlers::handle_get_tile_states(&state, &request.params),
        "save_tile_state" => handlers::handle_save_tile_state(&state, &request.params),
        "delete_tile_state" => handlers::handle_delete_tile_state(&state, &request.params),
        "clear_tile_states" => handlers::handle_clear_tile_states(&state, &request.params),

        // Settings methods
        "get_all_settings" => handlers::handle_get_all_settings(&state, &request.params),
        "get_setting" => handlers::handle_get_setting(&state, &request.params),
        "update_setting" => handlers::handle_update_setting(&state, &request.params),

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
    let request_id = format!("req-{}", uuid::Uuid::new_v4());
    let input_session_id = body.get("inputSessionId").and_then(|v| v.as_str());
    let (tx, rx) = tokio::sync::oneshot::channel::<Value>();

    // Store pending request
    {
        let state = app.lock().await;
        state.acp_pending.insert(request_id.clone(), tx);
    }

    // Broadcast command to frontend
    let notification = WsNotification {
        method: "acp-command-new-session".into(),
        params: serde_json::json!({
            "requestId": request_id,
            "inputSessionId": input_session_id,
        }),
    };
    let broadcast_json = serde_json::to_string(&notification).unwrap_or_default();

    {
        let state = app.lock().await;
        let _ = state.acp_cmd_tx.send(broadcast_json);
    }

    // Wait for frontend response (timeout after 30s)
    match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
        Ok(Ok(result)) => {
            let session_id = result.get("sessionId").and_then(|v| v.as_str());
            match session_id {
                Some(id) => {
                    let mut resp = serde_json::json!({ "sessionId": id });
                    if let Some(input_id) = input_session_id {
                        resp["inputSessionId"] = serde_json::Value::String(input_id.to_string());
                    }
                    (StatusCode::OK, Json(resp)).into_response()
                }
                None => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Missing sessionId in response" }))).into_response(),
            }
        }
        Ok(Err(_)) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Channel closed" }))).into_response(),
        Err(_) => {
            // Clean up pending request on timeout
            let state = app.lock().await;
            state.acp_pending.remove(&request_id);
            (StatusCode::GATEWAY_TIMEOUT, Json(serde_json::json!({ "error": "Timeout waiting for frontend" }))).into_response()
        }
    }
}

/// HTTP handler: POST /api/acp/sessions/:session_id/prompt
/// Async — broadcasts prompt command to frontend, returns immediately.
async fn prompt_session_handler(
    Path(session_id): Path<String>,
    State(app): State<App>,
    axum::Json(body): axum::Json<Value>,
) -> impl IntoResponse {
    let notification = WsNotification {
        method: "acp-command-prompt".into(),
        params: serde_json::json!({
            "sessionId": session_id,
            "blocks": body.get("blocks").unwrap_or(&serde_json::Value::Null),
        }),
    };
    let broadcast_json = serde_json::to_string(&notification).unwrap_or_default();

    let state = app.lock().await;
    let _ = state.acp_cmd_tx.send(broadcast_json);

    (StatusCode::ACCEPTED, Json(serde_json::json!({ "status": "queued" })))
}

/// HTTP handler: POST /api/acp/sessions/:session_id/cancel
/// Async — broadcasts cancel command to frontend, returns immediately.
async fn cancel_session_handler(
    Path(session_id): Path<String>,
    State(app): State<App>,
) -> impl IntoResponse {
    let notification = WsNotification {
        method: "acp-command-cancel".into(),
        params: serde_json::json!({ "sessionId": session_id }),
    };
    let broadcast_json = serde_json::to_string(&notification).unwrap_or_default();

    let state = app.lock().await;
    let _ = state.acp_cmd_tx.send(broadcast_json);

    (StatusCode::ACCEPTED, Json(serde_json::json!({ "status": "queued" })))
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
