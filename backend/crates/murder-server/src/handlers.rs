//! WebSocket request handlers — mirrors Tauri `#[tauri::command]` functions.

use std::path::Path;

use serde_json::{json, Value};

use crate::state::AppState;
use murder_text::{EditOperation, Position, Range, TextModel};

// ---------------------------------------------------------------------------
// Document handlers
// ---------------------------------------------------------------------------

pub fn handle_document_open(state: &AppState, params: &Value) -> Result<Value, String> {
    let path = params["path"].as_str().ok_or("missing 'path'")?;
    let content = params["content"].as_str().ok_or("missing 'content'")?.to_string();

    let language_id = detect_language(path);
    let uri = format!("file://{path}");

    let model = TextModel::new(&content, &language_id, &uri);

    let response = json!({
        "content": model.get_full_content(),
        "encoding": model.encoding.label().to_string(),
        "line_ending": model.line_ending.to_string(),
        "language_id": model.language_id,
        "version": model.version,
        "is_dirty": model.is_dirty,
        "is_readonly": model.is_readonly,
        "is_large_file": model.is_large_file,
        "line_count": model.line_count(),
    });

    state.documents.insert(path.to_string(), model);
    Ok(response)
}

pub fn handle_document_close(state: &AppState, params: &Value) -> Result<Value, String> {
    let path = params["path"].as_str().ok_or("missing 'path'")?;
    Ok(json!(state.documents.remove(path).is_some()))
}

pub fn handle_document_edit(state: &AppState, params: &Value) -> Result<Value, String> {
    let path = params["path"].as_str().ok_or("missing 'path'")?;
    let start_line = params["start_line"].as_u64().ok_or("missing 'start_line'")? as u32;
    let start_column = params["start_column"].as_u64().ok_or("missing 'start_column'")? as u32;
    let end_line = params["end_line"].as_u64().ok_or("missing 'end_line'")? as u32;
    let end_column = params["end_column"].as_u64().ok_or("missing 'end_column'")? as u32;
    let text = params["text"].as_str().ok_or("missing 'text'")?.to_string();

    let mut entry = state.documents.get_mut(path).ok_or_else(|| format!("Document not found: {path}"))?;
    let model = entry.value_mut();

    // Clamp ranges to document bounds to prevent ropey panics
    let line_count = model.line_count();
    if line_count == 0 {
        return Err("Document is empty".to_string());
    }

    let start_line = start_line.min(line_count - 1);
    let end_line = end_line.min(line_count - 1);
    let start_col_max = model.buffer.get_line_length(start_line);
    let end_col_max = model.buffer.get_line_length(end_line);
    let start_column = start_column.min(start_col_max);
    let end_column = end_column.min(end_col_max);

    let edit = EditOperation::replace(
        Range::new(Position::new(start_line, start_column), Position::new(end_line, end_column)),
        text,
    );
    model.apply_edit(&edit);

    Ok(json!({
        "version": model.version,
        "is_dirty": model.is_dirty,
    }))
}

pub fn handle_document_set_content(state: &AppState, params: &Value) -> Result<Value, String> {
    let path = params["path"].as_str().ok_or("missing 'path'")?;
    let content = params["content"].as_str().ok_or("missing 'content'")?.to_string();

    let mut entry = state.documents.get_mut(path).ok_or_else(|| format!("Document not found: {path}"))?;
    let model = entry.value_mut();

    // Replace entire content: delete all + insert new
    let line_count = model.line_count();
    if line_count == 0 {
        // Empty doc, just insert
        let edit = EditOperation::insert(Position::new(0, 0), content);
        model.apply_edit(&edit);
    } else {
        let last_line = line_count - 1;
        let last_col = model.buffer.get_line_length(last_line);
        let edit = EditOperation::replace(
            Range::new(Position::new(0, 0), Position::new(last_line, last_col)),
            content,
        );
        model.apply_edit(&edit);
    }

    Ok(json!({
        "version": model.version,
        "is_dirty": model.is_dirty,
    }))
}

pub async fn handle_document_save(state: &AppState, params: &Value) -> Result<Value, String> {
    let path = params["path"].as_str().ok_or("missing 'path'")?;

    let mut entry = state.documents.get_mut(path).ok_or_else(|| format!("Document not found: {path}"))?;
    let model = entry.value_mut();

    if model.is_readonly {
        return Err("Document is read-only".to_string());
    }

    // Get the save-transformed content (trims whitespace, ensures newline)
    let save_content = model.get_save_content();

    // Write to disk
    tokio::fs::write(path, &save_content)
        .await
        .map_err(|e| format!("Failed to write file: {e}"))?;

    // Mark saved
    model.mark_saved();

    Ok(json!({ "success": true, "version": model.version }))
}

pub fn handle_document_get_content(state: &AppState, params: &Value) -> Result<Value, String> {
    let path = params["path"].as_str().ok_or("missing 'path'")?;
    let entry = state.documents.get(path).ok_or_else(|| format!("Document not found: {path}"))?;
    Ok(json!({ "content": entry.value().get_full_content() }))
}

pub fn handle_document_get_info(state: &AppState, params: &Value) -> Result<Value, String> {
    let path = params["path"].as_str().ok_or("missing 'path'")?;
    let entry = state.documents.get(path).ok_or_else(|| format!("Document not found: {path}"))?;
    let model = entry.value();
    Ok(json!({
        "is_dirty": model.is_dirty,
        "version": model.version,
        "line_count": model.line_count(),
        "encoding": model.encoding.label().to_string(),
        "line_ending": model.line_ending.to_string(),
    }))
}

// ---------------------------------------------------------------------------
// Filesystem handlers
// ---------------------------------------------------------------------------

pub async fn handle_read_dir(params: &Value) -> Result<Value, String> {
    let path = params["path"].as_str().ok_or("missing 'path'")?;

    let entries = tokio::fs::read_dir(path)
        .await
        .map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    let mut stream = entries;
    while let Ok(Some(entry)) = stream.next_entry().await {
        let file_type = entry.file_type().await.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = file_type.is_dir();
        let full_path = entry.path().to_string_lossy().into_owned();

        result.push(json!({
            "name": name,
            "path": full_path,
            "is_dir": is_dir,
        }));
    }

    // Sort: directories first, then alphabetically
    result.sort_by(|a, b| {
        let a_dir = a["is_dir"].as_bool().unwrap_or(false);
        let b_dir = b["is_dir"].as_bool().unwrap_or(false);
        match (a_dir, b_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")),
        }
    });

    Ok(json!({ "entries": result }))
}

pub async fn handle_read_file(params: &Value) -> Result<Value, String> {
    let path = params["path"].as_str().ok_or("missing 'path'")?;
    let content = tokio::fs::read_to_string(path)
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({ "content": content }))
}

pub async fn handle_write_file(params: &Value) -> Result<Value, String> {
    let path = params["path"].as_str().ok_or("missing 'path'")?;
    let content = params["content"].as_str().ok_or("missing 'content'")?;
    tokio::fs::write(path, content)
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({ "success": true }))
}

pub async fn handle_exists(params: &Value) -> Result<Value, String> {
    let path = params["path"].as_str().ok_or("missing 'path'")?;
    Ok(json!({ "exists": Path::new(path).exists() }))
}

pub async fn handle_mkdir(params: &Value) -> Result<Value, String> {
    let path = params["path"].as_str().ok_or("missing 'path'")?;
    tokio::fs::create_dir_all(path)
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({ "success": true }))
}

pub async fn handle_remove(params: &Value) -> Result<Value, String> {
    let path = params["path"].as_str().ok_or("missing 'path'")?;
    let p = Path::new(path);
    if p.is_dir() {
        tokio::fs::remove_dir_all(p).await.map_err(|e| e.to_string())?;
    } else {
        tokio::fs::remove_file(p).await.map_err(|e| e.to_string())?;
    }
    Ok(json!({ "success": true }))
}

pub async fn handle_rename(params: &Value) -> Result<Value, String> {
    let from = params["from"].as_str().ok_or("missing 'from'")?;
    let to = params["to"].as_str().ok_or("missing 'to'")?;
    tokio::fs::rename(from, to)
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({ "success": true }))
}

pub async fn handle_stat(params: &Value) -> Result<Value, String> {
    let path = params["path"].as_str().ok_or("missing 'path'")?;
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({
        "size": metadata.len(),
        "is_dir": metadata.is_dir(),
        "is_file": metadata.is_file(),
        "modified": metadata.modified().ok().map(|t| {
            t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
        }),
    }))
}

pub async fn handle_create_file(params: &Value) -> Result<Value, String> {
    let path = params["path"].as_str().ok_or("missing 'path'")?;
    let content = params.get("content").and_then(|v| v.as_str()).unwrap_or("");
    tokio::fs::write(path, content)
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({ "success": true }))
}

pub async fn handle_create_dir(params: &Value) -> Result<Value, String> {
    let path = params["path"].as_str().ok_or("missing 'path'")?;
    tokio::fs::create_dir(path)
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({ "success": true }))
}

// ---------------------------------------------------------------------------
// Workspace handlers
// ---------------------------------------------------------------------------

pub fn handle_workspace_open(state: &AppState, params: &Value) -> Result<Value, String> {
    let path = params["path"].as_str().ok_or("missing 'path'")?;
    state.set_workspace(path);

    // Record in recently opened workspaces (SQLite)
    let _ = murder_db::recent::add_recent_workspace(&state.db.lock(), path);

    let root = Path::new(path);
    let tree = murder_workspace::FileTree::scan(root);

    let nodes = serialize_tree_nodes(&tree);
    Ok(json!({ "root": path, "nodes": nodes }))
}

pub fn handle_workspace_expand(state: &AppState, params: &Value) -> Result<Value, String> {
    let path = params["path"].as_str().ok_or("missing 'path'")?;

    let ws = state.workspace.lock();
    let ws = ws.as_ref().ok_or("No workspace open")?;

    let node = ws.file_tree().find(Path::new(path))
        .ok_or_else(|| format!("Path not in tree: {path}"))?;

    let children: Vec<Value> = node.children.iter()
        .flatten()
        .map(|c| json!({
            "name": c.name,
            "path": c.path.to_string_lossy(),
            "is_dir": c.is_dir,
        }))
        .collect();

    Ok(json!({ "children": children }))
}

fn serialize_tree_nodes(tree: &murder_workspace::FileTree) -> Vec<Value> {
    fn serialize_node(node: &murder_workspace::FileNode) -> Value {
        json!({
            "name": node.name,
            "path": node.path.to_string_lossy(),
            "is_dir": node.is_dir,
            "children": node.children.as_ref().map(|c| {
                c.iter().map(serialize_node).collect::<Vec<_>>()
            }),
        })
    }
    vec![serialize_node(&tree.root)]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn detect_language(path: &str) -> String {
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "rs" => "rust".into(),
        "ts" | "tsx" => "typescript".into(),
        "js" | "jsx" => "javascript".into(),
        "py" => "python".into(),
        "rb" => "ruby".into(),
        "go" => "go".into(),
        "java" => "java".into(),
        "c" | "h" => "c".into(),
        "cpp" | "cc" | "cxx" | "hpp" => "cpp".into(),
        "cs" => "csharp".into(),
        "css" | "scss" | "less" => "css".into(),
        "html" | "htm" => "html".into(),
        "json" => "json".into(),
        "md" | "markdown" => "markdown".into(),
        "sh" | "bash" | "zsh" => "shellscript".into(),
        "yml" | "yaml" => "yaml".into(),
        "toml" => "toml".into(),
        "xml" => "xml".into(),
        "sql" => "sql".into(),
        "php" => "php".into(),
        "swift" => "swift".into(),
        "kt" | "kts" => "kotlin".into(),
        "lua" => "lua".into(),
        "r" => "r".into(),
        "dart" => "dart".into(),
        "scala" => "scala".into(),
        "perl" | "pl" => "perl".into(),
        "hs" => "haskell".into(),
        "ex" | "exs" => "elixir".into(),
        "erl" | "hrl" => "erlang".into(),
        "clj" | "cljs" => "clojure".into(),
        _ => "plaintext".into(),
    }
}

// ---------------------------------------------------------------------------
// Terminal handlers
// ---------------------------------------------------------------------------

pub fn handle_terminal_spawn(state: &AppState, params: &Value) -> Result<Value, String> {
    let shell = params["shell"].as_str();
    let cwd = params["cwd"].as_str();
    let cols = params["cols"].as_u64().map(|v| v as u16).unwrap_or(80);
    let rows = params["rows"].as_u64().map(|v| v as u16).unwrap_or(24);

    let mut tm = state.terminals.lock();
    let mut config = murder_terminal::PtySpawnConfig::default();
    config.size = murder_terminal::TerminalSize { rows, cols };

    if let Some(s) = shell {
        config.shell = Some(s.to_string());
    }

    if let Some(c) = cwd {
        if !c.is_empty() {
            config.cwd = Some(std::path::PathBuf::from(c));
        }
    }

    let id = tm.create_with_config(&config).map_err(|e| e.to_string())?;
    Ok(json!({ "id": id }))
}

pub fn handle_terminal_write(state: &AppState, params: &Value) -> Result<Value, String> {
    let id = params["id"].as_u64().ok_or("missing 'id'")? as u32;
    let data = params["data"].as_str().ok_or("missing 'data'")?;
    let tm = state.terminals.lock();
    tm.write(murder_terminal::TerminalId(id), data)
        .map_err(|e| e.to_string())?;
    Ok(json!({ "success": true }))
}

pub fn handle_terminal_resize(state: &AppState, params: &Value) -> Result<Value, String> {
    let id = params["id"].as_u64().ok_or("missing 'id'")? as u32;
    let cols = params["cols"].as_u64().ok_or("missing 'cols'")? as u16;
    let rows = params["rows"].as_u64().ok_or("missing 'rows'")? as u16;
    let tm = state.terminals.lock();
    tm.resize(
        murder_terminal::TerminalId(id),
        murder_terminal::TerminalSize { rows, cols },
    )
    .map_err(|e| e.to_string())?;
    Ok(json!({ "success": true }))
}

pub fn handle_terminal_kill(state: &AppState, params: &Value) -> Result<Value, String> {
    let id = params["id"].as_u64().ok_or("missing 'id'")? as u32;
    let mut tm = state.terminals.lock();
    tm.close_terminal(id).map_err(|e| e.to_string())?;
    Ok(json!({ "success": true }))
}

pub fn handle_terminal_info(state: &AppState, params: &Value) -> Result<Value, String> {
    let id = params["id"].as_u64().ok_or("missing 'id'")? as u32;
    let tm = state.terminals.lock();
    let info = tm
        .info(murder_terminal::TerminalId(id))
        .map_err(|e| e.to_string())?;
    Ok(json!({
        "id": info.handle.0,
        "shell": info.shell,
        "cwd": info.cwd,
        "pid": info.pid,
        "cols": info.cols,
        "rows": info.rows,
        "is_alive": info.is_alive,
    }))
}

pub fn handle_get_default_shell(_state: &AppState, _params: &Value) -> Result<Value, String> {
    let shell = murder_terminal::detect_default_shell();
    Ok(json!({ "shell": shell }))
}

pub fn handle_get_available_shells(_state: &AppState, _params: &Value) -> Result<Value, String> {
    let shells = murder_terminal::available_shells()
        .into_iter()
        .map(|s| json!({
            "name": s.name,
            "path": s.path,
            "is_default": s.is_default,
        }))
        .collect::<Vec<_>>();
    Ok(json!({ "shells": shells }))
}

// ---------------------------------------------------------------------------
// ACP handlers
// ---------------------------------------------------------------------------

pub async fn handle_acp_relay(state: &AppState, params: &Value) -> Result<Value, String> {
    let agent_id = params["agentId"].as_str().ok_or("missing 'agentId'")?;
    let message = params["message"].as_str().ok_or("missing 'message'")?;

    let stdin = state.agents.get_stdin(agent_id).await
        .ok_or_else(|| format!("Agent not found: {agent_id}"))?;

    stdin.send(message.to_string()).await
        .map_err(|e| format!("Failed to send to agent: {e}"))?;

    Ok(json!({ "success": true }))
}

pub async fn handle_acp_spawn(state: &AppState, params: &Value) -> Result<Value, String> {
    let name = params["name"].as_str().ok_or("missing 'name'")?;
    let command = params["command"].as_str().ok_or("missing 'command'")?;
    let cwd = params["cwd"].as_str().unwrap_or(".");

    let args = params["args"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    let env = params["env"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    let config = murder_acp::AgentConfig {
        name: name.to_string(),
        command: command.to_string(),
        args,
        env,
    };

    let agent_id = state.agents.spawn(&config, cwd).await
        .map_err(|e| format!("Failed to spawn agent: {e}"))?;

    Ok(json!({ "agentId": agent_id }))
}

pub async fn handle_acp_send(state: &AppState, params: &Value) -> Result<Value, String> {
    let agent_id = params["agentId"].as_str().ok_or("missing 'agentId'")?;
    let message = params["message"].as_str().ok_or("missing 'message'")?;

    let stdin = state.agents.get_stdin(agent_id).await
        .ok_or_else(|| format!("Agent not found: {agent_id}"))?;

    stdin.send(message.to_string()).await
        .map_err(|e| format!("Failed to send to agent: {e}"))?;

    Ok(json!({ "success": true }))
}

pub async fn handle_acp_kill(state: &AppState, params: &Value) -> Result<Value, String> {
    let agent_id = params["agentId"].as_str().ok_or("missing 'agentId'")?;
    state.agents.kill(agent_id).await;
    Ok(json!({ "success": true }))
}

pub async fn handle_acp_read_file(state: &AppState, params: &Value) -> Result<Value, String> {
    let path = params["path"].as_str().ok_or("missing 'path'")?;

    // Check if document is open (has unsaved changes)
    let content = if let Some(entry) = state.documents.get(path) {
        entry.value().get_full_content()
    } else {
        tokio::fs::read_to_string(path)
            .await
            .map_err(|e| format!("Failed to read file: {e}"))?
    };

    // Handle line/limit parameters
    let content = if params["line"].is_number() || params["limit"].is_number() {
        let start_line = params["line"].as_u64().unwrap_or(1).saturating_sub(1) as usize;
        let lines: Vec<&str> = content.split('\n').collect();
        let end_line = if params["limit"].is_number() {
            start_line + params["limit"].as_u64().unwrap_or(0) as usize
        } else {
            lines.len()
        };
        lines.get(start_line..end_line.min(lines.len())).unwrap_or(&[]).join("\n")
    } else {
        content
    };

    Ok(json!({ "content": content }))
}

pub async fn handle_acp_write_file(state: &AppState, params: &Value) -> Result<Value, String> {
    let path = params["path"].as_str().ok_or("missing 'path'")?;
    let content = params["content"].as_str().ok_or("missing 'content'")?;

    // Capture old content before writing (for diff views)
    let old_content = state.worktree_state.lock().record_write(
        Path::new(path),
        content,
    );

    // Write to disk
    tokio::fs::write(path, content)
        .await
        .map_err(|e| format!("Failed to write file: {e}"))?;

    // If document is open, update it
    if let Some(mut entry) = state.documents.get_mut(path) {
        let model = entry.value_mut();
        let line_count = model.line_count();
        if line_count == 0 {
            let edit = murder_text::EditOperation::insert(murder_text::Position::new(0, 0), content.to_string());
            model.apply_edit(&edit);
        } else {
            let last_line = line_count - 1;
            let last_col = model.buffer.get_line_length(last_line);
            let edit = murder_text::EditOperation::replace(
                murder_text::Range::new(murder_text::Position::new(0, 0), murder_text::Position::new(last_line, last_col)),
                content.to_string(),
            );
            model.apply_edit(&edit);
        }
        model.mark_saved();
    }

    Ok(json!({
        "success": true,
        "old_content": old_content,
    }))
}

// ---------------------------------------------------------------------------
// ACP terminal handlers
// ---------------------------------------------------------------------------

pub async fn handle_acp_create_terminal(state: &AppState, params: &Value) -> Result<Value, String> {
    let command = params["command"].as_str().ok_or("missing 'command'")?;
    let cwd = params.get("cwd").and_then(|v| v.as_str());

    let args: Vec<String> = params["args"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    let env: Vec<(String, String)> = params["env"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| {
                    let obj = v.as_object()?;
                    let name = obj.get("name")?.as_str()?;
                    let value = obj.get("value")?.as_str()?;
                    Some((name.to_string(), value.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();

    let output_byte_limit = params["outputByteLimit"].as_u64().map(|v| v as usize);

    let terminal_id = state.agents.terminals
        .create_terminal(&command, &args, &env, cwd, output_byte_limit)
        .await
        .map_err(|e| format!("Failed to create terminal: {e}"))?;

    Ok(json!({ "terminalId": terminal_id }))
}

pub async fn handle_acp_terminal_output(state: &AppState, params: &Value) -> Result<Value, String> {
    let terminal_id = params["terminalId"].as_str().ok_or("missing 'terminalId'")?;

    let (output, truncated) = state.agents.terminals
        .terminal_output(terminal_id)
        .await
        .ok_or_else(|| format!("Terminal not found: {terminal_id}"))?;

    let (exited, exit_code, exit_signal) = state.agents.terminals
        .terminal_info(terminal_id)
        .await
        .ok_or_else(|| format!("Terminal not found: {terminal_id}"))?;

    let mut result = json!({
        "output": output,
        "truncated": truncated,
    });

    if exited {
        let mut status = serde_json::Map::new();
        if let Some(code) = exit_code {
            status.insert("exitCode".into(), json!(code));
        }
        if let Some(signal) = exit_signal {
            status.insert("signal".into(), json!(signal));
        }
        result["exitStatus"] = json!(status);
    }

    Ok(result)
}

pub async fn handle_acp_wait_for_terminal_exit(state: &AppState, params: &Value) -> Result<Value, String> {
    let terminal_id = params["terminalId"].as_str().ok_or("missing 'terminalId'")?;

    let start = std::time::Instant::now();
    loop {
        if let Some((exited, exit_code, exit_signal)) = state.agents.terminals.terminal_info(terminal_id).await {
            if exited {
                let mut result = serde_json::Map::new();
                if let Some(code) = exit_code {
                    result.insert("exitCode".into(), json!(code));
                }
                if let Some(signal) = exit_signal {
                    result.insert("signal".into(), json!(signal));
                }
                return Ok(json!(result));
            }
        }
        if start.elapsed().as_secs() > 300 {
            return Err(format!("Terminal {} did not exit within 5 minutes", terminal_id));
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}

pub async fn handle_acp_kill_terminal(state: &AppState, params: &Value) -> Result<Value, String> {
    let terminal_id = params["terminalId"].as_str().ok_or("missing 'terminalId'")?;
    state.agents.terminals.kill_terminal(terminal_id).await;
    Ok(json!({ "success": true }))
}

pub async fn handle_acp_release_terminal(state: &AppState, params: &Value) -> Result<Value, String> {
    let terminal_id = params["terminalId"].as_str().ok_or("missing 'terminalId'")?;
    state.agents.terminals.release_terminal(terminal_id).await;
    Ok(json!({ "success": true }))
}

pub async fn handle_acp_terminal_write_input(state: &AppState, params: &Value) -> Result<Value, String> {
    let terminal_id = params["terminalId"].as_str().ok_or("missing 'terminalId'")?;
    let data = params["data"].as_str().ok_or("missing 'data'")?;
    state.agents.terminals.write_input(terminal_id, data).await
        .map_err(|e| format!("Failed to write to terminal: {e}"))?;
    Ok(json!({ "success": true }))
}

pub async fn handle_acp_terminal_resize(state: &AppState, params: &Value) -> Result<Value, String> {
    let terminal_id = params["terminalId"].as_str().ok_or("missing 'terminalId'")?;
    let cols = params["cols"].as_u64().ok_or("missing 'cols'")? as u16;
    let rows = params["rows"].as_u64().ok_or("missing 'rows'")? as u16;
    state.agents.terminals.resize_terminal(terminal_id, rows, cols).await
        .map_err(|e| format!("Failed to resize terminal: {e}"))?;
    Ok(json!({ "success": true }))
}

// ---------------------------------------------------------------------------
// Worktree state handlers
// ---------------------------------------------------------------------------

/// Get the "before" content for a file that was recently changed.
/// Used by the chat panel to show diffs for agent edits.
pub async fn handle_get_file_before_content(state: &AppState, params: &Value) -> Result<Value, String> {
    let path = params["path"].as_str().ok_or("missing 'path'")?;
    let before = state.worktree_state.lock().get_before_content(Path::new(path));
    Ok(json!({
        "content": before,
    }))
}

/// Get the full change record (old + new content) for a file.
pub async fn handle_get_file_change(state: &AppState, params: &Value) -> Result<Value, String> {
    let path = params["path"].as_str().ok_or("missing 'path'")?;
    let change = state.worktree_state.lock().get_change(Path::new(path));
    if let Some(c) = change {
        Ok(json!({
            "path": c.path.to_string_lossy().to_string(),
            "old_content": c.old_content,
            "new_content": c.new_content,
            "kind": match c.kind {
                murder_workspace::FileEventKind::Created => "created",
                murder_workspace::FileEventKind::Modified => "modified",
                murder_workspace::FileEventKind::Deleted => "deleted",
                murder_workspace::FileEventKind::Renamed => "renamed",
            },
        }))
    } else {
        Ok(json!({ "content": null }))
    }
}

/// Get the platform-specific global config path for Murder IDE.
/// Returns `~/.crow/murder.json` expanded to an absolute path.
pub fn handle_get_config_path(_state: &AppState, _params: &Value) -> Result<Value, String> {
    let home = dirs::home_dir().ok_or("could not determine home directory")?;
    let config_dir = home.join(".crow");
    let config_file = config_dir.join("murder.json");
    // Ensure the config directory exists
    std::fs::create_dir_all(&config_dir).map_err(|e| format!("failed to create config dir: {e}"))?;
    Ok(json!({ "path": config_file.to_string_lossy().to_string() }))
}

// ---------------------------------------------------------------------------
// Session state handlers (backed by SQLite, not JSON config)
// ---------------------------------------------------------------------------

/// Get recently opened workspaces from the database.
pub fn handle_get_recent_workspaces(state: &AppState, params: &Value) -> Result<Value, String> {
    let limit = params["limit"].as_u64().unwrap_or(10) as usize;
    let workspaces = murder_db::recent::recent_workspaces(&state.db.lock(), limit)
        .map_err(|e| format!("failed to query recent workspaces: {e}"))?;
    Ok(json!(workspaces))
}

/// Add a workspace to the recently opened list.
pub fn handle_add_recent_workspace(state: &AppState, params: &Value) -> Result<Value, String> {
    let path = params["path"].as_str().ok_or("missing 'path'")?;
    murder_db::recent::add_recent_workspace(&state.db.lock(), path)
        .map_err(|e| format!("failed to add recent workspace: {e}"))?;
    Ok(json!({ "success": true }))
}

// ---------------------------------------------------------------------------
// Mosaic layout handlers (SQLite-backed, per workspace)
// ---------------------------------------------------------------------------

/// Resolve workspace path: from params or from AppState.
fn resolve_workspace(state: &AppState, params: &Value) -> Result<String, String> {
    if let Some(ws) = params["workspace"].as_str() {
        return Ok(ws.to_string());
    }
    state.workspace_root().ok_or("no workspace open".to_string())
}

/// Load the mosaic layout tree for the current workspace.
pub fn handle_get_mosaic_layout(state: &AppState, params: &Value) -> Result<Value, String> {
    let workspace = resolve_workspace(state, params)?;
    let layout = murder_db::layout::load_mosaic_layout(&state.db.lock(), &workspace)
        .map_err(|e| format!("failed to load mosaic layout: {e}"))?;
    Ok(json!({ "layout": layout }))
}

/// Save the mosaic layout tree for the current workspace.
pub fn handle_save_mosaic_layout(state: &AppState, params: &Value) -> Result<Value, String> {
    let workspace = resolve_workspace(state, params)?;
    let layout_json = params["layout"].as_str().ok_or("missing 'layout'")?;
    murder_db::layout::save_mosaic_layout(&state.db.lock(), &workspace, layout_json)
        .map_err(|e| format!("failed to save mosaic layout: {e}"))?;
    Ok(json!({ "success": true }))
}

// ---------------------------------------------------------------------------
// Explorer state handlers (SQLite-backed, per workspace)
// ---------------------------------------------------------------------------

/// Load explorer state (expanded dirs + active file) for the current workspace.
pub fn handle_get_explorer_state(state: &AppState, params: &Value) -> Result<Value, String> {
    let workspace = resolve_workspace(state, params)?;
    let state_data = murder_db::layout::load_explorer_state(&state.db.lock(), &workspace)
        .map_err(|e| format!("failed to load explorer state: {e}"))?;
    Ok(json!({
        "expanded_dirs": state_data.as_ref().map(|(d, _)| d.as_str()).unwrap_or("[]"),
        "active_file": state_data.and_then(|(_, f)| f),
    }))
}

/// Save explorer state for the current workspace.
pub fn handle_save_explorer_state(state: &AppState, params: &Value) -> Result<Value, String> {
    let workspace = resolve_workspace(state, params)?;
    let expanded_dirs = params["expanded_dirs"].as_str().ok_or("missing 'expanded_dirs'")?;
    let active_file = params.get("active_file").and_then(|v| v.as_str());
    murder_db::layout::save_explorer_state(&state.db.lock(), &workspace, expanded_dirs, active_file)
        .map_err(|e| format!("failed to save explorer state: {e}"))?;
    Ok(json!({ "success": true }))
}

// ---------------------------------------------------------------------------
// Tile state handlers (SQLite-backed, per workspace)
// ---------------------------------------------------------------------------

/// Load all tile states for the current workspace.
pub fn handle_get_tile_states(state: &AppState, params: &Value) -> Result<Value, String> {
    let workspace = resolve_workspace(state, params)?;
    let tiles = murder_db::layout::load_tile_states(&state.db.lock(), &workspace)
        .map_err(|e| format!("failed to load tile states: {e}"))?;
    let tiles_json: Vec<Value> = tiles
        .into_iter()
        .map(|(id, tile_type, state_json, minimized)| {
            json!({
                "tileId": id,
                "tileType": tile_type,
                "state": state_json,
                "isMinimized": minimized,
            })
        })
        .collect();
    Ok(json!({ "tiles": tiles_json }))
}

/// Save or update a tile's state.
pub fn handle_save_tile_state(state: &AppState, params: &Value) -> Result<Value, String> {
    let workspace = resolve_workspace(state, params)?;
    let tile_id = params["tileId"].as_str().ok_or("missing 'tileId'")?;
    let tile_type = params["tileType"].as_str().ok_or("missing 'tileType'")?;
    let state_json = params["state"].as_str().ok_or("missing 'state'")?;
    let is_minimized = params["isMinimized"].as_bool().unwrap_or(false);
    murder_db::layout::save_tile_state(&state.db.lock(), &workspace, tile_id, tile_type, state_json, is_minimized)
        .map_err(|e| format!("failed to save tile state: {e}"))?;
    Ok(json!({ "success": true }))
}

/// Delete a tile's state.
pub fn handle_delete_tile_state(state: &AppState, params: &Value) -> Result<Value, String> {
    let workspace = resolve_workspace(state, params)?;
    let tile_id = params["tileId"].as_str().ok_or("missing 'tileId'")?;
    murder_db::layout::delete_tile_state(&state.db.lock(), &workspace, tile_id)
        .map_err(|e| format!("failed to delete tile state: {e}"))?;
    Ok(json!({ "success": true }))
}

/// Delete all tile states for the current workspace (called on workspace close).
pub fn handle_clear_tile_states(state: &AppState, params: &Value) -> Result<Value, String> {
    let workspace = resolve_workspace(state, params)?;
    murder_db::layout::delete_tile_states(&state.db.lock(), &workspace)
        .map_err(|e| format!("failed to clear tile states: {e}"))?;
    Ok(json!({ "success": true }))
}
