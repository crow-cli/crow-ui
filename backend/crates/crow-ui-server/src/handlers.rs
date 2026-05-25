//! WebSocket request handlers — mirrors Tauri `#[tauri::command]` functions.

use std::path::Path;

use serde_json::{json, Value};

use crate::protocol::*;
use crate::state::AppState;
use crow_ui_text::{EditOperation, Position, Range, TextModel};

// ---------------------------------------------------------------------------
// Document handlers
// ---------------------------------------------------------------------------

pub fn handle_document_open(state: &AppState, req: DocumentOpenRequest) -> Result<DocumentOpenResponse, String> {
    // If document already exists, return it — don't overwrite with potentially stale content
    if let Some(entry) = state.documents.get(&req.path) {
        let model = entry.value();
        return Ok(DocumentOpenResponse {
            content: model.get_full_content(),
            encoding: model.encoding.label().to_string(),
            line_ending: model.line_ending.to_string(),
            language_id: model.language_id.clone(),
            version: model.version,
            is_dirty: model.is_dirty,
            is_readonly: model.is_readonly,
            is_large_file: model.is_large_file,
            line_count: model.line_count(),
        });
    }

    // Read from disk — frontend may send empty placeholder content before fetching
    let content = std::fs::read_to_string(&req.path).unwrap_or_default();

    let language_id = detect_language(&req.path);
    let uri = format!("file://{}", req.path);

    let model = TextModel::new(&content, &language_id, &uri);

    let response = DocumentOpenResponse {
        content: model.get_full_content(),
        encoding: model.encoding.label().to_string(),
        line_ending: model.line_ending.to_string(),
        language_id: model.language_id.clone(),
        version: model.version,
        is_dirty: model.is_dirty,
        is_readonly: model.is_readonly,
        is_large_file: model.is_large_file,
        line_count: model.line_count(),
    };

    state.documents.insert(req.path, model);
    Ok(response)
}

pub fn handle_document_close(state: &AppState, req: DocumentCloseRequest) -> Result<Value, String> {
    Ok(json!(state.documents.remove(&req.path).is_some()))
}

pub fn handle_document_edit(state: &AppState, req: DocumentEditRequest) -> Result<Value, String> {
    let mut entry = state.documents.get_mut(&req.path).ok_or_else(|| format!("Document not found: {}", req.path))?;
    let model = entry.value_mut();

    // Clamp ranges to document bounds to prevent ropey panics
    let line_count = model.line_count();
    if line_count == 0 {
        return Err("Document is empty".to_string());
    }

    let start_line = (req.edit.start_line as u32).min(line_count - 1);
    let end_line = (req.edit.end_line as u32).min(line_count - 1);
    let start_col_max = model.buffer.get_line_length(start_line);
    let end_col_max = model.buffer.get_line_length(end_line);
    let start_col = (req.edit.start_col as u32).min(start_col_max);
    let end_col = (req.edit.end_col as u32).min(end_col_max);

    let edit = EditOperation::replace(
        Range::new(Position::new(start_line, start_col), Position::new(end_line, end_col)),
        req.edit.new_text,
    );
    model.apply_edit(&edit);

    Ok(json!({
        "version": model.version,
        "is_dirty": model.is_dirty,
    }))
}

pub fn handle_document_set_content(state: &AppState, req: DocumentSetContentRequest) -> Result<Value, String> {
    let mut entry = state.documents.get_mut(&req.path).ok_or_else(|| format!("Document not found: {}", req.path))?;
    let model = entry.value_mut();

    // Replace entire content: delete all + insert new
    let line_count = model.line_count();
    if line_count == 0 {
        // Empty doc, just insert
        let edit = EditOperation::insert(Position::new(0, 0), req.content);
        model.apply_edit(&edit);
    } else {
        let last_line = line_count - 1;
        let last_col = model.buffer.get_line_length(last_line);
        let edit = EditOperation::replace(
            Range::new(Position::new(0, 0), Position::new(last_line, last_col)),
            req.content,
        );
        model.apply_edit(&edit);
    }

    Ok(json!({
        "version": model.version,
        "is_dirty": model.is_dirty,
    }))
}

pub async fn handle_document_save(state: &AppState, req: DocumentSaveRequest) -> Result<DocumentSaveResponse, String> {
    let mut entry = state.documents.get_mut(&req.path).ok_or_else(|| format!("Document not found: {}", req.path))?;
    let model = entry.value_mut();

    if model.is_readonly {
        return Err("Document is read-only".to_string());
    }

    // Get the save-transformed content (trims whitespace, ensures newline)
    let save_content = model.get_save_content();

    // Write to disk
    tokio::fs::write(&req.path, &save_content)
        .await
        .map_err(|e| format!("Failed to write file: {e}"))?;

    // Mark saved
    model.mark_saved();

    Ok(DocumentSaveResponse { success: true, version: model.version })
}

pub fn handle_document_get_content(state: &AppState, req: DocumentGetContentRequest) -> Result<DocumentGetContentResponse, String> {
    let entry = state.documents.get(&req.path).ok_or_else(|| format!("Document not found: {}", req.path))?;
    Ok(DocumentGetContentResponse { content: entry.value().get_full_content() })
}

pub fn handle_document_get_info(state: &AppState, req: DocumentGetInfoRequest) -> Result<DocumentGetInfoResponse, String> {
    let entry = state.documents.get(&req.path).ok_or_else(|| format!("Document not found: {}", req.path))?;
    let model = entry.value();
    Ok(DocumentGetInfoResponse {
        path: req.path,
        is_dirty: model.is_dirty,
        version: model.version,
        line_count: model.line_count(),
    })
}

// ---------------------------------------------------------------------------
// Filesystem handlers
// ---------------------------------------------------------------------------

pub async fn handle_read_dir(req: ReadDirRequest) -> Result<ReadDirResponse, String> {
    let mut entries = tokio::fs::read_dir(&req.path)
        .await
        .map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name().to_string_lossy().into_owned();
        let file_type = entry.file_type().await.map_err(|e| e.to_string())?;
        let is_dir = file_type.is_dir();
        let is_file = file_type.is_file();
        let full_path = entry.path().to_string_lossy().into_owned();
        let size = entry.metadata().await.map(|m| m.len()).unwrap_or(0);
        let modified = entry.metadata().await.ok().and_then(|m| {
            m.modified().ok().and_then(|t| {
                t.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_secs().to_string())
            })
        });

        result.push(DirEntry {
            name,
            path: full_path,
            is_dir,
            is_file,
            size,
            modified,
        });
    }

    // Sort: directories first, then alphabetically
    result.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.cmp(&b.name),
        }
    });

    Ok(ReadDirResponse { entries: result })
}

pub async fn handle_read_file(state: &AppState, req: ReadFileRequest) -> Result<ReadFileResponse, String> {
    // Check document model first (includes unsaved/dirty editor content)
    let content = if let Some(entry) = state.documents.get(&req.path) {
        entry.value().get_full_content()
    } else {
        tokio::fs::read_to_string(&req.path)
            .await
            .map_err(|e| e.to_string())?
    };

    Ok(ReadFileResponse { content })
}

pub async fn handle_write_file(state: &AppState, req: WriteFileRequest) -> Result<Value, String> {
    // Record change for diff views
    let old_content = state.worktree_state.lock().record_write(Path::new(&req.path), &req.content);

    // Write to disk
    tokio::fs::write(&req.path, &req.content)
        .await
        .map_err(|e| e.to_string())?;

    // If document is open, update it and mark saved
    if let Some(mut entry) = state.documents.get_mut(&req.path) {
        let model = entry.value_mut();
        let line_count = model.line_count();
        if line_count == 0 {
            let edit = crow_ui_text::EditOperation::insert(crow_ui_text::Position::new(0, 0), req.content.clone());
            model.apply_edit(&edit);
        } else {
            let last_line = line_count - 1;
            let last_col = model.buffer.get_line_length(last_line);
            let edit = crow_ui_text::EditOperation::replace(
                crow_ui_text::Range::new(crow_ui_text::Position::new(0, 0), crow_ui_text::Position::new(last_line, last_col)),
                req.content.clone(),
            );
            model.apply_edit(&edit);
        }
        model.mark_saved();
    }

    Ok(json!({ "success": true, "old_content": old_content }))
}

pub async fn handle_exists(req: ExistsRequest) -> Result<ExistsResponse, String> {
    Ok(ExistsResponse { exists: Path::new(&req.path).exists() })
}

pub async fn handle_remove(req: RemoveRequest) -> Result<RemoveResponse, String> {
    let p = Path::new(&req.path);
    if p.is_dir() {
        tokio::fs::remove_dir_all(p).await.map_err(|e| e.to_string())?;
    } else {
        tokio::fs::remove_file(p).await.map_err(|e| e.to_string())?;
    }
    Ok(RemoveResponse { success: true })
}

pub async fn handle_rename(req: RenameRequest) -> Result<RenameResponse, String> {
    tokio::fs::rename(&req.from, &req.to)
        .await
        .map_err(|e| e.to_string())?;
    Ok(RenameResponse { success: true })
}

pub async fn handle_stat(req: StatRequest) -> Result<StatResponse, String> {
    let metadata = tokio::fs::metadata(&req.path)
        .await
        .map_err(|e| e.to_string())?;
    let modified = metadata.modified().ok().and_then(|t| {
        t.duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_secs().to_string())
    });
    Ok(StatResponse {
        size: metadata.len(),
        is_dir: metadata.is_dir(),
        is_file: metadata.is_file(),
        modified,
    })
}

pub async fn handle_create_file(req: CreateFileRequest) -> Result<CreateFileResponse, String> {
    tokio::fs::write(&req.path, &req.content)
        .await
        .map_err(|e| e.to_string())?;
    Ok(CreateFileResponse { success: true })
}

pub async fn handle_create_dir(req: CreateDirRequest) -> Result<CreateDirResponse, String> {
    tokio::fs::create_dir(&req.path)
        .await
        .map_err(|e| e.to_string())?;
    Ok(CreateDirResponse { success: true })
}

// ---------------------------------------------------------------------------
// Workspace handlers
// ---------------------------------------------------------------------------

/// Get the currently open workspace from in-memory state.
/// Returns null if no workspace is open (e.g. after server restart).
pub fn handle_get_current_workspace(state: &AppState, _req: GetCurrentWorkspaceRequest) -> Result<GetCurrentWorkspaceResponse, String> {
    Ok(GetCurrentWorkspaceResponse {
        workspace: state.workspace_root(),
    })
}

pub fn handle_workspace_open(state: &AppState, req: WorkspaceOpenRequest) -> Result<WorkspaceOpenResponse, String> {
    state.set_workspace(&req.path);

    // Record in recently opened workspaces (SQLite)
    let _ = crow_ui_db::recent::add_recent_workspace(&state.db.lock(), &req.path);

    let root = Path::new(&req.path);
    let tree = crow_ui_workspace::FileTree::scan(root);

    let nodes = serialize_tree_nodes(&tree);
    Ok(WorkspaceOpenResponse { root: req.path, nodes: json!(nodes) })
}

pub fn handle_workspace_expand(state: &AppState, req: WorkspaceExpandRequest) -> Result<WorkspaceExpandResponse, String> {
    let ws = state.workspace.lock();
    let ws = ws.as_ref().ok_or("No workspace open")?;

    let node = ws.file_tree().find(Path::new(&req.path))
        .ok_or_else(|| format!("Path not in tree: {}", req.path))?;

    let children: Vec<WorkspaceChild> = node.children.iter()
        .flatten()
        .map(|c| WorkspaceChild {
            name: c.name.clone(),
            path: c.path.to_string_lossy().to_string(),
            is_dir: c.is_dir,
        })
        .collect();

    Ok(WorkspaceExpandResponse { children })
}

fn serialize_tree_nodes(tree: &crow_ui_workspace::FileTree) -> Vec<Value> {
    fn serialize_node(node: &crow_ui_workspace::FileNode) -> Value {
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

pub fn handle_terminal_spawn(state: &AppState, req: TerminalSpawnRequest) -> Result<TerminalSpawnResponse, String> {
    let mut tm = state.terminals.lock();
    let mut config = crow_ui_terminal::PtySpawnConfig::default();
    config.size = crow_ui_terminal::TerminalSize {
        rows: req.rows.unwrap_or(24),
        cols: req.cols.unwrap_or(80),
    };

    if let Some(s) = req.shell {
        config.shell = Some(s);
    }

    if let Some(c) = req.cwd {
        if !c.is_empty() {
            config.cwd = Some(std::path::PathBuf::from(c));
        }
    }

    let id = tm.create_with_config(&config).map_err(|e| e.to_string())?;
    Ok(TerminalSpawnResponse {
        id: id.0,
        shell: config.shell.unwrap_or_default(),
        pid: 0, // TerminalManager doesn't expose pid directly
    })
}

pub fn handle_terminal_write(state: &AppState, req: TerminalWriteRequest) -> Result<Value, String> {
    let tm = state.terminals.lock();
    tm.write(crow_ui_terminal::TerminalId(req.id), &req.data)
        .map_err(|e| e.to_string())?;
    Ok(json!({ "success": true }))
}

pub fn handle_terminal_resize(state: &AppState, req: TerminalResizeRequest) -> Result<Value, String> {
    let tm = state.terminals.lock();
    tm.resize(
        crow_ui_terminal::TerminalId(req.id),
        crow_ui_terminal::TerminalSize { rows: req.rows, cols: req.cols },
    )
    .map_err(|e| e.to_string())?;
    Ok(json!({ "success": true }))
}

pub fn handle_terminal_kill(state: &AppState, req: TerminalKillRequest) -> Result<Value, String> {
    let mut tm = state.terminals.lock();
    tm.close_terminal(req.id).map_err(|e| e.to_string())?;
    Ok(json!({ "success": true }))
}

pub fn handle_terminal_info(state: &AppState, req: TerminalInfoRequest) -> Result<TerminalInfoResponse, String> {
    let tm = state.terminals.lock();
    let info = tm
        .info(crow_ui_terminal::TerminalId(req.id))
        .map_err(|e| e.to_string())?;
    Ok(TerminalInfoResponse {
        id: info.handle.0,
        shell: info.shell,
        pid: info.pid,
        cwd: info.cwd,
    })
}

pub fn handle_get_default_shell(_state: &AppState, _req: GetDefaultShellRequest) -> Result<GetDefaultShellResponse, String> {
    let shell = crow_ui_terminal::detect_default_shell();
    Ok(GetDefaultShellResponse { shell })
}

pub fn handle_get_available_shells(_state: &AppState, _req: GetAvailableShellsRequest) -> Result<GetAvailableShellsResponse, String> {
    let shells = crow_ui_terminal::available_shells()
        .into_iter()
        .map(|s| ShellInfo {
            name: s.name,
            path: s.path,
            is_default: s.is_default,
        })
        .collect();
    Ok(GetAvailableShellsResponse { shells })
}

// ---------------------------------------------------------------------------
// ACP handlers
// ---------------------------------------------------------------------------

pub async fn handle_acp_relay(state: &AppState, req: AcpRelayRequest) -> Result<AcpRelayResponse, String> {
    let stdin = state.agents.get_stdin(&req.agent_id).await
        .ok_or_else(|| format!("Agent not found: {}", req.agent_id))?;

    stdin.send(req.message).await
        .map_err(|e| format!("Failed to send to agent: {e}"))?;

    Ok(AcpRelayResponse { success: true })
}

pub async fn handle_acp_spawn(state: &AppState, req: AcpSpawnRequest) -> Result<AcpSpawnResponse, String> {
    let config = crow_ui_acp::AgentConfig {
        name: req.name,
        command: req.command,
        args: req.args,
        env: req.env,
    };

    let agent_id = state.agents.spawn(&config, &req.cwd).await
        .map_err(|e| format!("Failed to spawn agent: {e}"))?;

    Ok(AcpSpawnResponse { agent_id })
}

pub async fn handle_acp_send(state: &AppState, req: AcpSendRequest) -> Result<AcpSendResponse, String> {
    let stdin = state.agents.get_stdin(&req.agent_id).await
        .ok_or_else(|| format!("Agent not found: {}", req.agent_id))?;

    stdin.send(req.message).await
        .map_err(|e| format!("Failed to send to agent: {e}"))?;

    Ok(AcpSendResponse { success: true })
}

pub async fn handle_acp_kill(state: &AppState, req: AcpKillRequest) -> Result<AcpKillResponse, String> {
    state.agents.kill(&req.agent_id).await;
    Ok(AcpKillResponse { success: true })
}

pub async fn handle_acp_read_file(state: &AppState, req: AcpReadFileRequest) -> Result<AcpReadFileResponse, String> {
    // Check if document is open (has unsaved changes)
    let content = if let Some(entry) = state.documents.get(&req.path) {
        entry.value().get_full_content()
    } else {
        tokio::fs::read_to_string(&req.path)
            .await
            .map_err(|e| format!("Failed to read file: {e}"))?
    };

    Ok(AcpReadFileResponse { content })
}

pub async fn handle_acp_write_file(state: &AppState, req: AcpWriteFileRequest) -> Result<AcpWriteFileResponse, String> {
    // Capture old content before writing (for diff views)
    let old_content = state.worktree_state.lock().record_write(
        Path::new(&req.path),
        &req.content,
    );

    // Write to disk
    tokio::fs::write(&req.path, &req.content)
        .await
        .map_err(|e| format!("Failed to write file: {e}"))?;

    // If document is open, update it
    if let Some(mut entry) = state.documents.get_mut(&req.path) {
        let model = entry.value_mut();
        let line_count = model.line_count();
        if line_count == 0 {
            let edit = crow_ui_text::EditOperation::insert(crow_ui_text::Position::new(0, 0), req.content.clone());
            model.apply_edit(&edit);
        } else {
            let last_line = line_count - 1;
            let last_col = model.buffer.get_line_length(last_line);
            let edit = crow_ui_text::EditOperation::replace(
                crow_ui_text::Range::new(crow_ui_text::Position::new(0, 0), crow_ui_text::Position::new(last_line, last_col)),
                req.content.clone(),
            );
            model.apply_edit(&edit);
        }
        model.mark_saved();
    }

    Ok(AcpWriteFileResponse { success: true, old_content })
}

// ---------------------------------------------------------------------------
// ACP terminal handlers
// ---------------------------------------------------------------------------

pub async fn handle_acp_create_terminal(state: &AppState, req: AcpCreateTerminalRequest) -> Result<AcpCreateTerminalResponse, String> {
    let env: Vec<(String, String)> = req.env.into_iter().map(|e| (e.name, e.value)).collect();
    let terminal_id = state.agents.terminals
        .create_terminal(&req.command, &req.args, &env, req.cwd.as_deref(), req.output_byte_limit, req.timeout_ms, None)
        .await
        .map_err(|e| format!("Failed to create terminal: {e}"))?;

    Ok(AcpCreateTerminalResponse { terminal_id })
}

pub async fn handle_acp_terminal_output(state: &AppState, req: AcpTerminalOutputRequest) -> Result<AcpTerminalOutputResponse, String> {
    let (output, truncated) = state.agents.terminals
        .terminal_output(&req.terminal_id)
        .await
        .ok_or_else(|| format!("Terminal not found: {}", req.terminal_id))?;

    let (exited, exit_code, exit_signal) = state.agents.terminals
        .terminal_info(&req.terminal_id)
        .await
        .ok_or_else(|| format!("Terminal not found: {}", req.terminal_id))?;

    let cwd = state.agents.terminals
        .terminal_cwd(&req.terminal_id)
        .await;

    let exit_status = if exited {
        Some(AcpExitStatus { exit_code, signal: exit_signal })
    } else {
        None
    };

    Ok(AcpTerminalOutputResponse { output, truncated, cwd, exit_status })
}

pub async fn handle_acp_wait_for_terminal_exit(state: &AppState, req: AcpWaitForTerminalExitRequest) -> Result<AcpWaitForTerminalExitResponse, String> {
    let start = std::time::Instant::now();
    loop {
        if let Some((exited, exit_code, exit_signal)) = state.agents.terminals.terminal_info(&req.terminal_id).await {
            if exited {
                return Ok(AcpWaitForTerminalExitResponse { exit_code, signal: exit_signal });
            }
        }
        if start.elapsed().as_secs() > 300 {
            return Err(format!("Terminal {} did not exit within 5 minutes", req.terminal_id));
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}

pub async fn handle_set_session_config_option(
    state: &AppState,
    req: SetSessionConfigOptionRequest,
) -> Result<SetSessionConfigOptionResponse, String> {
    let session = state
        .acp_sessions
        .get_session(&req.session_id)
        .await
        .ok_or_else(|| format!("Session not found: {}", req.session_id))?;

    let result = session
        .set_config_option(&req.config_id, &req.value)
        .await
        .map_err(|e| format!("Failed to set config option: {e}"))?;

    Ok(SetSessionConfigOptionResponse {
        config_options: result,
    })
}

pub async fn handle_acp_kill_terminal(state: &AppState, req: AcpKillTerminalRequest) -> Result<AcpKillTerminalResponse, String> {
    state.agents.terminals.kill_terminal(&req.terminal_id).await;
    Ok(AcpKillTerminalResponse { success: true })
}

pub async fn handle_acp_release_terminal(state: &AppState, req: AcpReleaseTerminalRequest) -> Result<AcpReleaseTerminalResponse, String> {
    state.agents.terminals.release_terminal(&req.terminal_id).await;
    Ok(AcpReleaseTerminalResponse { success: true })
}

pub async fn handle_acp_terminal_write_input(state: &AppState, req: AcpTerminalWriteInputRequest) -> Result<AcpTerminalWriteInputResponse, String> {
    state.agents.terminals.write_input(&req.terminal_id, &req.data).await
        .map_err(|e| format!("Failed to write to terminal: {e}"))?;
    Ok(AcpTerminalWriteInputResponse { success: true })
}

pub async fn handle_acp_terminal_resize(state: &AppState, req: AcpTerminalResizeRequest) -> Result<AcpTerminalResizeResponse, String> {
    state.agents.terminals.resize_terminal(&req.terminal_id, req.rows, req.cols).await
        .map_err(|e| format!("Failed to resize terminal: {e}"))?;
    Ok(AcpTerminalResizeResponse { success: true })
}

// ---------------------------------------------------------------------------
// Worktree state handlers
// ---------------------------------------------------------------------------

/// Get the "before" content for a file that was recently changed.
/// Used by the chat panel to show diffs for agent edits.
pub async fn handle_get_file_before_content(state: &AppState, req: GetFileBeforeContentRequest) -> Result<GetFileBeforeContentResponse, String> {
    let before = state.worktree_state.lock().get_before_content(Path::new(&req.path));
    Ok(GetFileBeforeContentResponse { content: before.unwrap_or_default() })
}

/// Get the full change record (old + new content) for a file.
pub async fn handle_get_file_change(state: &AppState, req: GetFileChangeRequest) -> Result<GetFileChangeResponse, String> {
    let change = state.worktree_state.lock().get_change(Path::new(&req.path));
    if let Some(c) = change {
        Ok(GetFileChangeResponse {
            path: Some(c.path.to_string_lossy().to_string()),
            old_content: Some(c.old_content),
            new_content: Some(c.new_content),
            kind: Some(match c.kind {
                crow_ui_workspace::FileEventKind::Created => "created".to_string(),
                crow_ui_workspace::FileEventKind::Modified => "modified".to_string(),
                crow_ui_workspace::FileEventKind::Deleted => "deleted".to_string(),
                crow_ui_workspace::FileEventKind::Renamed => "renamed".to_string(),
            }),
        })
    } else {
        Ok(GetFileChangeResponse { path: None, old_content: None, new_content: None, kind: None })
    }
}

// ---------------------------------------------------------------------------
// Session state handlers (backed by SQLite, not JSON config)
// ---------------------------------------------------------------------------

/// Get recently opened workspaces from the database.
pub fn handle_get_recent_workspaces(state: &AppState, req: GetRecentWorkspacesRequest) -> Result<GetRecentWorkspacesResponse, String> {
    let workspaces = crow_ui_db::recent::recent_workspaces(&state.db.lock(), req.limit)
        .map_err(|e| format!("failed to query recent workspaces: {e}"))?;
    let entries = workspaces.into_iter().map(|w| RecentWorkspaceEntry {
        path: w.path,
        last_opened: w.last_opened,
    }).collect();
    Ok(GetRecentWorkspacesResponse { entries })
}

/// Add a workspace to the recently opened list.
pub fn handle_add_recent_workspace(state: &AppState, req: AddRecentWorkspaceRequest) -> Result<AddRecentWorkspaceResponse, String> {
    crow_ui_db::recent::add_recent_workspace(&state.db.lock(), &req.path)
        .map_err(|e| format!("failed to add recent workspace: {e}"))?;
    Ok(AddRecentWorkspaceResponse { success: true })
}

// ---------------------------------------------------------------------------
// Workspace layout handlers (SQLite-backed, per workspace)
// ---------------------------------------------------------------------------

/// Resolve workspace path: from params or from AppState.
fn resolve_workspace(state: &AppState, req_workspace: &Option<String>) -> Result<String, String> {
    if let Some(ws) = req_workspace {
        return Ok(ws.clone());
    }
    state.workspace_root().ok_or("no workspace open".to_string())
}

/// Load the workspace layout (flexlayout JSON) for the current workspace.
pub fn handle_get_workspace_layout(state: &AppState, req: GetWorkspaceLayoutRequest) -> Result<GetWorkspaceLayoutResponse, String> {
    let workspace = resolve_workspace(state, &req.workspace)?;
    let layout = crow_ui_db::layout::load_workspace_layout(&state.db.lock(), &workspace)
        .map_err(|e| format!("failed to load workspace layout: {e}"))?;
    Ok(GetWorkspaceLayoutResponse { layout })
}

/// Save the workspace layout (flexlayout JSON) for the current workspace.
pub fn handle_save_workspace_layout(state: &AppState, req: SaveWorkspaceLayoutRequest) -> Result<SaveWorkspaceLayoutResponse, String> {
    let workspace = resolve_workspace(state, &req.workspace)?;
    crow_ui_db::layout::save_workspace_layout(&state.db.lock(), &workspace, &req.layout)
        .map_err(|e| format!("failed to save workspace layout: {e}"))?;
    Ok(SaveWorkspaceLayoutResponse { success: true })
}

// ---------------------------------------------------------------------------
// Explorer state handlers (SQLite-backed, per workspace)
// ---------------------------------------------------------------------------

/// Load explorer state (expanded dirs + active file) for the current workspace.
pub fn handle_get_explorer_state(state: &AppState, req: GetExplorerStateRequest) -> Result<GetExplorerStateResponse, String> {
    let workspace = resolve_workspace(state, &req.workspace)?;
    let state_data = crow_ui_db::layout::load_explorer_state(&state.db.lock(), &workspace)
        .map_err(|e| format!("failed to load explorer state: {e}"))?;
    Ok(GetExplorerStateResponse {
        expanded_dirs: state_data.as_ref().map(|(d, _)| d.clone()).unwrap_or_else(|| "[]".to_string()),
        active_file: state_data.and_then(|(_, f)| f),
    })
}

/// Save explorer state for the current workspace.
pub fn handle_save_explorer_state(state: &AppState, req: SaveExplorerStateRequest) -> Result<SaveExplorerStateResponse, String> {
    let workspace = resolve_workspace(state, &req.workspace)?;
    crow_ui_db::layout::save_explorer_state(&state.db.lock(), &workspace, &req.expanded_dirs, req.active_file.as_deref())
        .map_err(|e| format!("failed to save explorer state: {e}"))?;
    Ok(SaveExplorerStateResponse { success: true })
}

// ---------------------------------------------------------------------------
// Tile state handlers (SQLite-backed, per workspace)
// ---------------------------------------------------------------------------

/// Load all tile states for the current workspace.
pub fn handle_get_tile_states(state: &AppState, req: GetTileStatesRequest) -> Result<GetTileStatesResponse, String> {
    let workspace = resolve_workspace(state, &req.workspace)?;
    let tiles = crow_ui_db::layout::load_tile_states(&state.db.lock(), &workspace)
        .map_err(|e| format!("failed to load tile states: {e}"))?;
    let tiles: Vec<TileState> = tiles
        .into_iter()
        .map(|(id, tile_type, state_json, minimized)| TileState {
            tile_id: id,
            tile_type,
            state: state_json,
            is_minimized: minimized,
        })
        .collect();
    Ok(GetTileStatesResponse { tiles })
}

/// Save or update a tile's state.
pub fn handle_save_tile_state(state: &AppState, req: SaveTileStateRequest) -> Result<SaveTileStateResponse, String> {
    let workspace = resolve_workspace(state, &req.workspace)?;
    crow_ui_db::layout::save_tile_state(&state.db.lock(), &workspace, &req.tile_id, &req.tile_type, &req.state, req.is_minimized)
        .map_err(|e| format!("failed to save tile state: {e}"))?;
    Ok(SaveTileStateResponse { success: true })
}

/// Delete a tile's state.
pub fn handle_delete_tile_state(state: &AppState, req: DeleteTileStateRequest) -> Result<DeleteTileStateResponse, String> {
    let workspace = resolve_workspace(state, &req.workspace)?;
    crow_ui_db::layout::delete_tile_state(&state.db.lock(), &workspace, &req.tile_id)
        .map_err(|e| format!("failed to delete tile state: {e}"))?;
    Ok(DeleteTileStateResponse { success: true })
}

/// Delete all tile states for the current workspace (called on workspace close).
pub fn handle_clear_tile_states(state: &AppState, req: ClearTileStatesRequest) -> Result<ClearTileStatesResponse, String> {
    let workspace = resolve_workspace(state, &req.workspace)?;
    crow_ui_db::layout::delete_tile_states(&state.db.lock(), &workspace)
        .map_err(|e| format!("failed to clear tile states: {e}"))?;
    Ok(ClearTileStatesResponse { success: true })
}

// ---------------------------------------------------------------------------
// Settings handlers (backend-driven, flat keys internally, nested externally)
// ---------------------------------------------------------------------------

/// Return all resolved settings as a nested JSON object.
pub fn handle_get_all_settings(state: &AppState, _req: GetAllSettingsRequest) -> Result<GetAllSettingsResponse, String> {
    let s = state.settings.lock();
    Ok(GetAllSettingsResponse { settings: s.to_nested() })
}

/// Get a single setting value by dot-notation key.
pub fn handle_get_setting(state: &AppState, req: GetSettingRequest) -> Result<GetSettingResponse, String> {
    let s = state.settings.lock();
    Ok(GetSettingResponse { value: s.get_raw(&req.key).cloned() })
}

/// Update a single setting in the user layer, persist to disk, and broadcast.
pub fn handle_update_setting(state: &AppState, req: UpdateSettingRequest) -> Result<UpdateSettingResponse, String> {
    let mut s = state.settings.lock();
    s.set(&req.key, req.value.clone());

    // Persist to disk
    let settings_path = state.config_dir.join("crow-ui-settings.json");
    s.save_user(&settings_path).map_err(|e| format!("failed to save settings: {e}"))?;

    // Broadcast change to all connected clients
    let _ = state.settings_events_tx.send(req.key);

    Ok(UpdateSettingResponse { success: true })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_state() -> AppState {
        AppState::new()
    }

    #[test]
    fn document_open_creates_new_model() {
        let state = temp_state();
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        write!(tmp, "hello world").unwrap();

        let req = DocumentOpenRequest {
            path: tmp.path().to_string_lossy().to_string(),
            content: String::new(),
        };

        let resp = handle_document_open(&state, req).unwrap();
        assert_eq!(resp.content, "hello world");
        assert_eq!(resp.line_count, 1);
        assert!(!resp.is_dirty);
    }

    #[test]
    fn document_open_returns_existing_model() {
        let state = temp_state();
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        write!(tmp, "first").unwrap();

        let req = DocumentOpenRequest {
            path: tmp.path().to_string_lossy().to_string(),
            content: String::new(),
        };

        let _ = handle_document_open(&state, req.clone()).unwrap();
        let resp2 = handle_document_open(&state, req).unwrap();
        assert_eq!(resp2.content, "first");
    }

    #[test]
    fn document_close_removes_document() {
        let state = temp_state();
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        write!(tmp, "content").unwrap();

        let open_req = DocumentOpenRequest {
            path: tmp.path().to_string_lossy().to_string(),
            content: String::new(),
        };
        handle_document_open(&state, open_req).unwrap();

        let close_req = DocumentCloseRequest {
            path: tmp.path().to_string_lossy().to_string(),
        };
        let removed = handle_document_close(&state, close_req).unwrap();
        assert_eq!(removed, json!(true));

        // Second close returns false
        let close_req2 = DocumentCloseRequest {
            path: tmp.path().to_string_lossy().to_string(),
        };
        let removed2 = handle_document_close(&state, close_req2).unwrap();
        assert_eq!(removed2, json!(false));
    }

    #[test]
    fn document_get_content_returns_content() {
        let state = temp_state();
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        write!(tmp, "abc").unwrap();

        let open_req = DocumentOpenRequest {
            path: tmp.path().to_string_lossy().to_string(),
            content: String::new(),
        };
        handle_document_open(&state, open_req).unwrap();

        let get_req = DocumentGetContentRequest {
            path: tmp.path().to_string_lossy().to_string(),
        };
        let resp = handle_document_get_content(&state, get_req).unwrap();
        assert_eq!(resp.content, "abc");
    }

    #[test]
    fn document_get_info_returns_metadata() {
        let state = temp_state();
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        write!(tmp, "hello").unwrap();

        let open_req = DocumentOpenRequest {
            path: tmp.path().to_string_lossy().to_string(),
            content: String::new(),
        };
        handle_document_open(&state, open_req).unwrap();

        let info_req = DocumentGetInfoRequest {
            path: tmp.path().to_string_lossy().to_string(),
        };
        let resp = handle_document_get_info(&state, info_req).unwrap();
        println!("line_count={}, version={}, is_dirty={}", resp.line_count, resp.version, resp.is_dirty);
        assert!(resp.line_count > 0);
        assert!(!resp.is_dirty);
    }

    #[test]
    fn document_set_content_replaces_all() {
        let state = temp_state();
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        write!(tmp, "old").unwrap();

        let open_req = DocumentOpenRequest {
            path: tmp.path().to_string_lossy().to_string(),
            content: String::new(),
        };
        handle_document_open(&state, open_req).unwrap();

        let set_req = DocumentSetContentRequest {
            path: tmp.path().to_string_lossy().to_string(),
            content: "new content".to_string(),
        };
        handle_document_set_content(&state, set_req).unwrap();

        let get_req = DocumentGetContentRequest {
            path: tmp.path().to_string_lossy().to_string(),
        };
        let resp = handle_document_get_content(&state, get_req).unwrap();
        assert_eq!(resp.content, "new content");
    }

    #[test]
    fn document_edit_replaces_range() {
        let state = temp_state();
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        write!(tmp, "hello world").unwrap();

        let open_req = DocumentOpenRequest {
            path: tmp.path().to_string_lossy().to_string(),
            content: String::new(),
        };
        handle_document_open(&state, open_req).unwrap();

        let edit_req = DocumentEditRequest {
            path: tmp.path().to_string_lossy().to_string(),
            edit: TextEdit {
                start_line: 0,
                start_col: 6,
                end_line: 0,
                end_col: 11,
                new_text: "rust".to_string(),
            },
        };
        handle_document_edit(&state, edit_req).unwrap();

        let get_req = DocumentGetContentRequest {
            path: tmp.path().to_string_lossy().to_string(),
        };
        let resp = handle_document_get_content(&state, get_req).unwrap();
        assert_eq!(resp.content, "hello rust");
    }

    #[tokio::test]
    async fn document_save_writes_to_disk() {
        let state = temp_state();
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        write!(tmp, "original").unwrap();
        let path = tmp.path().to_string_lossy().to_string();
        // Keep temp file alive until end of test
        let _tmp = tmp;

        let open_req = DocumentOpenRequest {
            path: path.clone(),
            content: String::new(),
        };
        handle_document_open(&state, open_req).unwrap();

        let set_req = DocumentSetContentRequest {
            path: path.clone(),
            content: "modified".to_string(),
        };
        handle_document_set_content(&state, set_req).unwrap();

        let save_req = DocumentSaveRequest { path: path.clone() };
        let resp = handle_document_save(&state, save_req).await.unwrap();
        assert!(resp.success);

        let disk_content = tokio::fs::read_to_string(&path).await.unwrap();
        assert_eq!(disk_content, "modified\n"); // get_save_content appends trailing newline
    }

    #[tokio::test]
    async fn read_dir_lists_entries() {
        let tmp = tempfile::tempdir().unwrap();
        tokio::fs::write(tmp.path().join("a.txt"), "hello").await.unwrap();
        tokio::fs::create_dir(tmp.path().join("sub")).await.unwrap();

        let req = ReadDirRequest { path: tmp.path().to_string_lossy().to_string() };
        let resp = handle_read_dir(req).await.unwrap();
        assert_eq!(resp.entries.len(), 2);
        // Directories come first
        assert!(resp.entries[0].is_dir);
        assert!(!resp.entries[1].is_dir);
    }

    #[tokio::test]
    async fn read_file_reads_disk_content() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        tokio::fs::write(tmp.path(), "file content").await.unwrap();

        let state = temp_state();
        let req = ReadFileRequest { path: tmp.path().to_string_lossy().to_string() };
        let resp = handle_read_file(&state, req).await.unwrap();
        assert_eq!(resp.content, "file content");
    }

    #[tokio::test]
    async fn write_file_writes_to_disk() {
        let state = temp_state();
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let path = tmp.path().to_string_lossy().to_string();

        let req = WriteFileRequest { path: path.clone(), content: "written".to_string() };
        let result = handle_write_file(&state, req).await.unwrap();
        assert_eq!(result["success"], true);

        let content = tokio::fs::read_to_string(&path).await.unwrap();
        assert_eq!(content, "written");
    }

    #[tokio::test]
    async fn exists_checks_file_presence() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let req = ExistsRequest { path: tmp.path().to_string_lossy().to_string() };
        assert!(handle_exists(req).await.unwrap().exists);

        let req2 = ExistsRequest { path: "/nonexistent/path/123".to_string() };
        assert!(!handle_exists(req2).await.unwrap().exists);
    }

    #[tokio::test]
    async fn create_file_and_remove_work() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("new.txt").to_string_lossy().to_string();

        let create_req = CreateFileRequest { path: path.clone(), content: "new file".to_string() };
        let resp = handle_create_file(create_req).await.unwrap();
        assert!(resp.success);

        let content = tokio::fs::read_to_string(&path).await.unwrap();
        assert_eq!(content, "new file");

        let remove_req = RemoveRequest { path: path.clone() };
        let resp = handle_remove(remove_req).await.unwrap();
        assert!(resp.success);
        assert!(!tokio::fs::try_exists(&path).await.unwrap());
    }

    #[tokio::test]
    async fn create_dir_and_rename_work() {
        let tmp = tempfile::tempdir().unwrap();
        let dir_path = tmp.path().join("mydir").to_string_lossy().to_string();

        let create_req = CreateDirRequest { path: dir_path.clone() };
        let resp = handle_create_dir(create_req).await.unwrap();
        assert!(resp.success);
        assert!(tokio::fs::try_exists(&dir_path).await.unwrap());

        let new_path = tmp.path().join("renamed").to_string_lossy().to_string();
        let rename_req = RenameRequest { from: dir_path.clone(), to: new_path.clone() };
        let resp = handle_rename(rename_req).await.unwrap();
        assert!(resp.success);
        assert!(!tokio::fs::try_exists(&dir_path).await.unwrap());
        assert!(tokio::fs::try_exists(&new_path).await.unwrap());
    }

    #[tokio::test]
    async fn stat_returns_metadata() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        tokio::fs::write(tmp.path(), "stats").await.unwrap();

        let req = StatRequest { path: tmp.path().to_string_lossy().to_string() };
        let resp = handle_stat(req).await.unwrap();
        assert_eq!(resp.size, 5);
        assert!(!resp.is_dir);
        assert!(resp.is_file);
        assert!(resp.modified.is_some());
    }
}
