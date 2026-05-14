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
use std::sync::Arc;
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
    pub agents: Arc<AgentManager>,
    /// Backend-owned ACP sessions.
    pub acp_sessions: crate::acp_session::AcpSessionManager,
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
    /// Broadcast channel for backend ACP session events → all connected frontends.
    pub acp_session_events_tx: broadcast::Sender<crate::acp_session::SessionEvent>,
}

impl AppState {
    pub fn new() -> Self {
        let default_dir = dirs::home_dir()
            .map(|h| h.join(".crow"))
            .unwrap_or_else(|| Path::new(".").to_path_buf());
        Self::with_config_dir(&default_dir)
    }

    pub fn with_config_dir(config_dir: &Path) -> Self {
        let tm = TerminalManager::new();
        let worktree_events_tx = broadcast::Sender::new(256);
        let settings_events_tx = broadcast::Sender::new(16);
        let acp_cmd_tx = broadcast::Sender::new(256);
        let acp_session_events_tx = broadcast::Sender::new(1024);
        let _ = std::fs::create_dir_all(config_dir);
        let db_path = config_dir.join("state.db");
        let db = Database::open(&db_path).expect("failed to open state database");
        let settings_path = config_dir.join("crow-ui-settings.json");

        let mut settings = Settings::new();
        maybe_migrate_settings(&mut settings, &settings_path);
        if settings_path.exists() {
            let _ = settings.load_user(&settings_path);
        }

        let agents = Arc::new(AgentManager::new());
        Self {
            documents: DashMap::new(),
            workspace: Mutex::new(None),
            terminals: Mutex::new(tm),
            terminal_events_tx: broadcast::Sender::new(1024),
            agents: agents.clone(),
            acp_sessions: crate::acp_session::AcpSessionManager::new(agents),
            worktree_state: Mutex::new(WorktreeState::new(worktree_events_tx.clone())),
            worktree_events_tx,
            db: Mutex::new(db),
            settings: Mutex::new(settings),
            settings_events_tx,
            acp_cmd_tx,
            acp_pending: DashMap::new(),
            acp_session_events_tx,
        }
    }

    pub fn with_terminals(tm: TerminalManager, tx: broadcast::Sender<String>, config_dir: &Path) -> Self {
        let worktree_events_tx = broadcast::Sender::new(256);
        let settings_events_tx = broadcast::Sender::new(16);
        let acp_cmd_tx = broadcast::Sender::new(256);
        let acp_session_events_tx = broadcast::Sender::new(1024);
        let _ = std::fs::create_dir_all(config_dir);
        let db_path = config_dir.join("state.db");
        let db = Database::open(&db_path).expect("failed to open state database");
        let settings_path = config_dir.join("crow-ui-settings.json");

        let mut settings = Settings::new();
        maybe_migrate_settings(&mut settings, &settings_path);
        if settings_path.exists() {
            let _ = settings.load_user(&settings_path);
        }

        let agents = Arc::new(AgentManager::new());
        Self {
            documents: DashMap::new(),
            workspace: Mutex::new(None),
            terminals: Mutex::new(tm),
            terminal_events_tx: tx,
            agents: agents.clone(),
            acp_sessions: crate::acp_session::AcpSessionManager::new(agents),
            worktree_state: Mutex::new(WorktreeState::new(worktree_events_tx.clone())),
            worktree_events_tx,
            db: Mutex::new(db),
            settings: Mutex::new(settings),
            settings_events_tx,
            acp_cmd_tx,
            acp_pending: DashMap::new(),
            acp_session_events_tx,
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
