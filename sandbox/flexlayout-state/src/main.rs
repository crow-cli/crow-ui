use std::sync::Arc;

use axum::{
    body::Body,
    extract::{State, WebSocketUpgrade},
    http::{header, Response, StatusCode, Uri},
    response::IntoResponse,
    routing::get,
    Router,
};
use futures::{sink::SinkExt, stream::StreamExt};
use parking_lot::Mutex;
use rust_embed::{Embed, RustEmbed};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::broadcast;
use tracing::{info, warn};

// ─── Embedded Frontend ──────────────────────────────────────────────────────

#[derive(RustEmbed)]
#[folder = "frontend/dist"]
struct Assets;

// ─── State ──────────────────────────────────────────────────────────────────

#[derive(Clone, Serialize, Deserialize, Debug)]
struct Document {
    content: String,
    dirty: bool,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
struct AppStateInner {
    layout: serde_json::Value,
    documents: serde_json::Map<String, serde_json::Value>,
    workspace_root: String,
}

struct AppState {
    inner: Mutex<AppStateInner>,
    tx: broadcast::Sender<String>,
}

// ─── Default Layout ─────────────────────────────────────────────────────────

fn default_layout() -> serde_json::Value {
    json!({
        "global": {
            "tabEnableClose": true,
            "tabEnableRename": false,
            "tabSetEnableMaximize": true,
            "tabSetEnableMinimize": true,
        },
        "borders": [
            {
                "type": "border",
                "location": "left",
                "size": 220,
                "selected": 0,
                "children": [
                    {
                        "type": "tab",
                        "id": "explorer-tab",
                        "name": "Explorer",
                        "component": "explorer"
                    }
                ]
            }
        ],
        "layout": {
            "type": "row",
            "weight": 100,
            "children": [
                {
                    "type": "tabset",
                    "id": "editor-tabset",
                    "weight": 70,
                    "selected": 0,
                    "children": [
                        {
                            "type": "tab",
                            "id": "welcome-tab",
                            "name": "Welcome",
                            "component": "welcome"
                        }
                    ]
                },
                {
                    "type": "tabset",
                    "id": "bottom-tabset",
                    "weight": 30,
                    "selected": 0,
                    "children": [
                        {
                            "type": "tab",
                            "id": "terminal-tab",
                            "name": "Terminal",
                            "component": "terminal"
                        }
                    ]
                }
            ]
        }
    })
}

fn create_state(workspace_root: String) -> AppStateInner {
    AppStateInner {
        layout: default_layout(),
        documents: serde_json::Map::new(),
        workspace_root,
    }
}

// ─── Layout JSON Manipulation ───────────────────────────────────────────────
//
// These functions traverse and mutate the FlexLayout JSON tree. We use unsafe
// pointer casts to bypass the borrow checker because the tree structure ensures
// no aliasing: each node has exactly one parent, so returned references are
// always disjoint from intermediate traversal borrows.

unsafe fn find_node_mut<'a>(
    value: *mut serde_json::Value,
    id: &str,
) -> Option<&'a mut serde_json::Value> {
    let v = &mut *value;

    // Check if this node matches (using match to avoid overlapping borrows)
    let is_match = match v {
        serde_json::Value::Object(obj) => {
            obj.get("id").and_then(|x| x.as_str()) == Some(id)
        }
        _ => false,
    };

    if is_match {
        return Some(v);
    }

    match v {
        serde_json::Value::Array(arr) => {
            for item in arr.iter_mut() {
                if let Some(found) = find_node_mut(item as *mut _, id) {
                    return Some(found);
                }
            }
        }
        serde_json::Value::Object(obj) => {
            for (_, child) in obj.iter_mut() {
                if let Some(found) = find_node_mut(child as *mut _, id) {
                    return Some(found);
                }
            }
        }
        _ => {}
    }

    None
}

/// Remove a node by ID anywhere in the tree. Returns true if found and removed.
unsafe fn remove_node_by_id(value: *mut serde_json::Value, id: &str) -> bool {
    let v = &mut *value;

    if let Some(arr) = v.as_array_mut() {
        let mut i = 0;
        while i < arr.len() {
            let item = &mut arr[i];
            if item.get("id").and_then(|x| x.as_str()) == Some(id) {
                arr.remove(i);
                return true;
            }
            if remove_node_by_id(item as *mut _, id) {
                return true;
            }
            i += 1;
        }
    }

    if let Some(obj) = v.as_object_mut() {
        for (_, child) in obj.iter_mut() {
            if remove_node_by_id(child as *mut _, id) {
                return true;
            }
        }
    }

    false
}

/// Find the parent tabset of a tab with the given ID. Returns a raw pointer
/// to avoid borrow checker issues with recursive tree traversal.
unsafe fn find_parent_tabset_ptr(
    value: *mut serde_json::Value,
    tab_id: &str,
) -> *mut serde_json::Value {
    let v = &mut *value;

    match v {
        serde_json::Value::Array(arr) => {
            for i in 0..arr.len() {
                let item = &mut arr[i];

                // Check if this item is a tabset containing the target tab
                let is_target = match item {
                    serde_json::Value::Object(obj) => {
                        obj.get("type").and_then(|x| x.as_str()) == Some("tabset")
                            && obj.get("children")
                                .and_then(|c| c.as_array())
                                .map(|children| {
                                    children.iter().any(|child| {
                                        child.get("id").and_then(|x| x.as_str()) == Some(tab_id)
                                    })
                                })
                                .unwrap_or(false)
                    }
                    _ => false,
                };

                if is_target {
                    return item as *mut _;
                }

                let found = find_parent_tabset_ptr(item as *mut _, tab_id);
                if !found.is_null() {
                    return found;
                }
            }
        }
        serde_json::Value::Object(obj) => {
            for (_, child) in obj.iter_mut() {
                let found = find_parent_tabset_ptr(child as *mut _, tab_id);
                if !found.is_null() {
                    return found;
                }
            }
        }
        _ => {}
    }

    std::ptr::null_mut()
}

fn add_editor_tab(layout: &mut serde_json::Value, path: &str) {
    let tab_id = format!("file-{}", path.replace('/', "-").replace('.', "_"));
    let file_name = path.split('/').last().unwrap_or(path);
    let ext = file_name.split('.').last().unwrap_or("");
    let language = match ext {
        "rs" => "rust",
        "ts" => "typescript",
        "tsx" => "typescript",
        "js" => "javascript",
        "jsx" => "javascript",
        "py" => "python",
        "go" => "go",
        "json" => "json",
        "md" => "markdown",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        _ => "plaintext",
    };

    unsafe {
        if let Some(tabset) = find_node_mut(layout as *mut _, "editor-tabset") {
            if let Some(children) = tabset.get_mut("children").and_then(|c| c.as_array_mut()) {
                // Check if tab already exists
                let exists = children.iter().any(|c| {
                    c.get("id").and_then(|v| v.as_str()) == Some(&tab_id)
                });

                if !exists {
                    children.push(json!({
                        "type": "tab",
                        "id": tab_id,
                        "name": file_name,
                        "component": "editor",
                        "config": { "path": path, "language": language }
                    }));
                    tabset["selected"] = json!(children.len().saturating_sub(1));
                } else {
                    // Select existing tab
                    for (i, child) in children.iter().enumerate() {
                        if child.get("id").and_then(|v| v.as_str()) == Some(&tab_id) {
                            tabset["selected"] = json!(i);
                            break;
                        }
                    }
                }
            }
        }
    }
}

fn remove_tab(layout: &mut serde_json::Value, tab_id: &str) {
    unsafe {
        remove_node_by_id(layout as *mut _, tab_id);
    }
}

fn update_selected_tab(layout: &mut serde_json::Value, tab_id: &str) {
    unsafe {
        let ptr = find_parent_tabset_ptr(layout as *mut _, tab_id);
        if !ptr.is_null() {
            let tabset = &mut *ptr;
            if let Some(children) = tabset.get_mut("children").and_then(|c| c.as_array_mut()) {
                for (i, child) in children.iter().enumerate() {
                    if child.get("id").and_then(|v| v.as_str()) == Some(tab_id) {
                        tabset["selected"] = json!(i);
                        return;
                    }
                }
            }
        }
    }
}

// ─── WebSocket ──────────────────────────────────────────────────────────────

#[derive(Deserialize, Debug)]
#[serde(tag = "type")]
enum ClientAction {
    #[serde(rename = "open_file")]
    OpenFile { path: String },
    #[serde(rename = "close_tab")]
    CloseTab { tab_id: String },
    #[serde(rename = "edit_file")]
    EditFile { path: String, content: String },
    #[serde(rename = "save_file")]
    SaveFile { path: String },
    #[serde(rename = "select_tab")]
    SelectTab { tab_id: String },
    #[serde(rename = "read_dir")]
    ReadDir { path: String },
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum ServerMessage {
    #[serde(rename = "state")]
    State {
        layout: serde_json::Value,
        documents: serde_json::Map<String, serde_json::Value>,
    },
    #[serde(rename = "dir_entries")]
    DirEntries {
        path: String,
        entries: Vec<DirEntry>,
    },
}

#[derive(Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: axum::extract::ws::WebSocket, state: Arc<AppState>) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.tx.subscribe();

    // Send initial state
    let initial = {
        let inner = state.inner.lock();
        serde_json::to_string(&ServerMessage::State {
            layout: inner.layout.clone(),
            documents: inner.documents.clone(),
        })
        .unwrap()
    };
    if sender
        .send(axum::extract::ws::Message::Text(initial))
        .await
        .is_err()
    {
        return;
    }

    let send_task = tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            if sender
                .send(axum::extract::ws::Message::Text(msg))
                .await
                .is_err()
            {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = receiver.next().await {
        if let axum::extract::ws::Message::Text(text) = msg {
            if let Err(e) = handle_client_message(&state, &text).await {
                warn!("Error handling message: {}", e);
            }
        }
    }

    send_task.abort();
}

async fn handle_client_message(
    state: &Arc<AppState>,
    text: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let action: ClientAction = serde_json::from_str(text)?;
    info!("Received action: {:?}", action);

    match action {
        ClientAction::OpenFile { path } => {
            // Check if already open (sync)
            let needs_read = {
                let inner = state.inner.lock();
                !inner.documents.contains_key(&path)
            };

            // Read from disk outside the lock (async)
            let content = if needs_read {
                tokio::fs::read_to_string(&path).await.unwrap_or_default()
            } else {
                String::new()
            };

            let mut inner = state.inner.lock();
            if needs_read {
                let doc = json!({ "content": content, "dirty": false });
                inner.documents.insert(path.clone(), doc);
            }
            add_editor_tab(&mut inner.layout, &path);

            let msg = serde_json::to_string(&ServerMessage::State {
                layout: inner.layout.clone(),
                documents: inner.documents.clone(),
            })?;
            drop(inner);
            let _ = state.tx.send(msg);
        }
        ClientAction::CloseTab { tab_id } => {
            let mut inner = state.inner.lock();
            remove_tab(&mut inner.layout, &tab_id);

            let msg = serde_json::to_string(&ServerMessage::State {
                layout: inner.layout.clone(),
                documents: inner.documents.clone(),
            })?;
            drop(inner);
            let _ = state.tx.send(msg);
        }
        ClientAction::EditFile { path, content } => {
            let mut inner = state.inner.lock();
            if let Some(doc) = inner.documents.get_mut(&path) {
                if let Some(obj) = doc.as_object_mut() {
                    obj.insert("content".to_string(), json!(content));
                    obj.insert("dirty".to_string(), json!(true));
                }
            }

            let msg = serde_json::to_string(&ServerMessage::State {
                layout: inner.layout.clone(),
                documents: inner.documents.clone(),
            })?;
            drop(inner);
            let _ = state.tx.send(msg);
        }
        ClientAction::SaveFile { path } => {
            // Get content outside async (sync)
            let content = {
                let inner = state.inner.lock();
                inner
                    .documents
                    .get(&path)
                    .and_then(|d| d.get("content"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            };

            // Write to disk outside the lock (async)
            if let Some(content) = content {
                tokio::fs::write(&path, &content).await?;
            }

            let mut inner = state.inner.lock();
            if let Some(obj) = inner
                .documents
                .get_mut(&path)
                .and_then(|d| d.as_object_mut())
            {
                obj.insert("dirty".to_string(), json!(false));
            }

            let msg = serde_json::to_string(&ServerMessage::State {
                layout: inner.layout.clone(),
                documents: inner.documents.clone(),
            })?;
            drop(inner);
            let _ = state.tx.send(msg);
        }
        ClientAction::SelectTab { tab_id } => {
            let mut inner = state.inner.lock();
            update_selected_tab(&mut inner.layout, &tab_id);

            let msg = serde_json::to_string(&ServerMessage::State {
                layout: inner.layout.clone(),
                documents: inner.documents.clone(),
            })?;
            drop(inner);
            let _ = state.tx.send(msg);
        }
        ClientAction::ReadDir { path } => {
            let mut entries = vec![];
            if let Ok(mut dir) = tokio::fs::read_dir(&path).await {
                while let Ok(Some(entry)) = dir.next_entry().await {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name.starts_with('.') {
                        continue;
                    }
                    let full_path = entry.path().to_string_lossy().into_owned();
                    let is_dir = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
                    entries.push(DirEntry {
                        name,
                        path: full_path,
                        is_dir,
                    });
                }
            }
            entries.sort_by(|a, b| {
                match (a.is_dir, b.is_dir) {
                    (true, false) => std::cmp::Ordering::Less,
                    (false, true) => std::cmp::Ordering::Greater,
                    _ => a.name.cmp(&b.name),
                }
            });

            let msg = serde_json::to_string(&ServerMessage::DirEntries { path, entries })?;
            let _ = state.tx.send(msg);
        }
    }

    Ok(())
}

// ─── Static File Handler ────────────────────────────────────────────────────

async fn static_handler(uri: Uri) -> impl IntoResponse {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    match Assets::get(path) {
        Some(content) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            let mut res = Response::new(Body::from(content.data));
            res.headers_mut().insert(
                header::CONTENT_TYPE,
                header::HeaderValue::from_str(mime.as_ref()).unwrap_or_else(|_| {
                    header::HeaderValue::from_static("application/octet-stream")
                }),
            );
            res
        }
        None => {
            // SPA fallback
            match Assets::get("index.html") {
                Some(content) => {
                    let mut res = Response::new(Body::from(content.data));
                    res.headers_mut().insert(
                        header::CONTENT_TYPE,
                        header::HeaderValue::from_static("text/html"),
                    );
                    res
                }
                None => Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Body::from("Not found"))
                    .unwrap(),
            }
        }
    }
}

// ─── Main ───────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let workspace_root = std::env::args()
        .nth(1)
        .unwrap_or_else(|| std::env::current_dir().unwrap().to_string_lossy().to_string());

    info!("Workspace root: {}", workspace_root);

    let (tx, _) = broadcast::channel(100);
    let state = Arc::new(AppState {
        inner: Mutex::new(create_state(workspace_root)),
        tx,
    });

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .fallback(static_handler)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:7777").await.unwrap();
    info!("Server running on http://localhost:7777");
    axum::serve(listener, app).await.unwrap();
}
