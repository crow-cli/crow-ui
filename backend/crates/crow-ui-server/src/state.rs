use std::path::Path;

use crow_ui_settings::Settings;
use crow_ui_acp::AgentManager;
use crow_ui_db::Database;
use crow_ui_terminal::TerminalManager;
use crow_ui_text::TextModel;
use crow_ui_workspace::{Workspace, WorktreeState};
use dashmap::DashMap;
use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::{broadcast, oneshot};

/// Migrate legacy `murder.json` (nested JSONC) to `crow-ui-settings.json` (flat JSON).
fn maybe_migrate_settings(settings: &mut Settings, settings_path: &Path) {
    if settings_path.exists() {
        return; // Already migrated
    }
    let legacy_path = dirs::home_dir()
        .map(|h| h.join(".crow").join("murder.json"))
        .unwrap_or_else(|| Path::new("murder.json").to_path_buf());
    if !legacy_path.exists() {
        return;
    }
    let content = match std::fs::read_to_string(&legacy_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[settings] failed to read legacy settings: {e}");
            return;
        }
    };
    // Strip JSONC comments and trailing commas
    let stripped = content
        .replace("// Murder IDE Settings — global config (~/.crow/murder.json)\n", "")
        .replace("// JSONC format — comments and trailing commas supported\n", "")
        .replace("\n", " ")
        .replace("//", "");
    let parsed: Value = match serde_json::from_str(&stripped) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[settings] failed to parse legacy settings: {e}");
            return;
        }
    };
    fn flatten(prefix: &str, value: &Value, out: &mut Vec<(String, Value)>) {
        match value {
            Value::Object(map) => {
                for (k, v) in map {
                    let key = if prefix.is_empty() {
                        k.clone()
                    } else {
                        format!("{prefix}.{k}")
                    };
                    flatten(&key, v, out);
                }
            }
            other => out.push((prefix.to_string(), other.clone())),
        }
    }
    let mut flat = Vec::new();
    flatten("", &parsed, &mut flat);
    let count = flat.len();
    for (key, value) in flat {
        if !key.is_empty() {
            settings.set(&key, value);
        }
    }
    if let Err(e) = settings.save_user(settings_path) {
        eprintln!("[settings] failed to save migrated settings: {e}");
    } else {
        println!("[settings] migrated {count} keys from murder.json");
    }
}

/// Shared application state accessible from WebSocket handlers.
pub struct AppState {
    /// Open documents keyed by file path.
    pub documents: DashMap<String, TextModel>,
    /// Current workspace (root directory).
    pub workspace: Mutex<Option<Workspace>>,
    /// Terminal sessions.
    pub terminals: Mutex<TerminalManager>,
    /// Broadcast channel for terminal events → all connected WebSocket clients.
    pub terminal_events_tx: broadcast::Sender<String>,
    /// ACP agent process manager (uses tokio::sync::Mutex internally).
    pub agents: AgentManager,
    /// Worktree state tracker — knows file content before/after changes.
    pub worktree_state: Mutex<WorktreeState>,
    /// Broadcast channel for worktree events → all connected WebSocket clients.
    pub worktree_events_tx: broadcast::Sender<String>,
    /// SQLite database for session state (recent workspaces, layout, etc.).
    /// Wrapped in Mutex because rusqlite's Connection is !Sync.
    pub db: Mutex<Database>,
    /// Layered settings store (default < user < workspace).
    pub settings: Mutex<Settings>,
    /// Broadcast channel for settings changes → all connected WebSocket clients.
    pub settings_events_tx: broadcast::Sender<String>,
    /// Broadcast channel for ACP control commands → frontend AcpClient.
    pub acp_cmd_tx: broadcast::Sender<String>,
    /// Pending synchronous ACP commands waiting for frontend response.
    /// Key: request_id, Value: oneshot sender for the response.
    pub acp_pending: DashMap<String, oneshot::Sender<Value>>,
}

impl AppState {
    pub fn new() -> Self {
        let tm = TerminalManager::new();
        let worktree_events_tx = broadcast::Sender::new(256);
        let settings_events_tx = broadcast::Sender::new(16);
        let acp_cmd_tx = broadcast::Sender::new(256);
        let db = Database::open_default().expect("failed to open state database");
        let settings_path = dirs::home_dir()
            .map(|h| h.join(".crow").join("crow-ui-settings.json"))
            .unwrap_or_else(|| Path::new("crow-ui-settings.json").to_path_buf());

        let mut settings = Settings::new();
        maybe_migrate_settings(&mut settings, &settings_path);
        if settings_path.exists() {
            let _ = settings.load_user(&settings_path);
        }

        Self {
            documents: DashMap::new(),
            workspace: Mutex::new(None),
            terminals: Mutex::new(tm),
            terminal_events_tx: broadcast::Sender::new(1024),
            agents: AgentManager::new(),
            worktree_state: Mutex::new(WorktreeState::new(worktree_events_tx.clone())),
            worktree_events_tx,
            db: Mutex::new(db),
            settings: Mutex::new(settings),
            settings_events_tx,
            acp_cmd_tx,
            acp_pending: DashMap::new(),
        }
    }

    pub fn with_terminals(tm: TerminalManager, tx: broadcast::Sender<String>) -> Self {
        let worktree_events_tx = broadcast::Sender::new(256);
        let settings_events_tx = broadcast::Sender::new(16);
        let acp_cmd_tx = broadcast::Sender::new(256);
        let db = Database::open_default().expect("failed to open state database");
        let settings_path = dirs::home_dir()
            .map(|h| h.join(".crow").join("crow-ui-settings.json"))
            .unwrap_or_else(|| Path::new("crow-ui-settings.json").to_path_buf());

        let mut settings = Settings::new();
        maybe_migrate_settings(&mut settings, &settings_path);
        if settings_path.exists() {
            let _ = settings.load_user(&settings_path);
        }

        Self {
            documents: DashMap::new(),
            workspace: Mutex::new(None),
            terminals: Mutex::new(tm),
            terminal_events_tx: tx,
            agents: AgentManager::new(),
            worktree_state: Mutex::new(WorktreeState::new(worktree_events_tx.clone())),
            worktree_events_tx,
            db: Mutex::new(db),
            settings: Mutex::new(settings),
            settings_events_tx,
            acp_cmd_tx,
            acp_pending: DashMap::new(),
        }
    }

    pub fn set_workspace(&self, root: &str) {
        let mut ws = self.workspace.lock();
        *ws = Some(Workspace::open(Path::new(root)));

        // Initialize worktree state for this workspace
        self.worktree_state
            .lock()
            .open_workspace(Path::new(root));
    }

    pub fn workspace_root(&self) -> Option<String> {
        self.workspace.lock().as_ref().map(|w| w.root().to_string_lossy().into_owned())
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
