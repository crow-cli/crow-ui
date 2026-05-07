use std::path::Path;

use murder_acp::AgentManager;
use murder_db::Database;
use murder_terminal::TerminalManager;
use murder_text::TextModel;
use murder_workspace::{Workspace, WorktreeState};
use dashmap::DashMap;
use parking_lot::Mutex;
use tokio::sync::broadcast;

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
}

impl AppState {
    pub fn new() -> Self {
        let tm = TerminalManager::new();
        let worktree_events_tx = broadcast::Sender::new(256);
        let db = Database::open_default().expect("failed to open state database");
        Self {
            documents: DashMap::new(),
            workspace: Mutex::new(None),
            terminals: Mutex::new(tm),
            terminal_events_tx: broadcast::Sender::new(1024),
            agents: AgentManager::new(),
            worktree_state: Mutex::new(WorktreeState::new(worktree_events_tx.clone())),
            worktree_events_tx,
            db: Mutex::new(db),
        }
    }

    pub fn with_terminals(tm: TerminalManager, tx: broadcast::Sender<String>) -> Self {
        let worktree_events_tx = broadcast::Sender::new(256);
        let db = Database::open_default().expect("failed to open state database");
        Self {
            documents: DashMap::new(),
            workspace: Mutex::new(None),
            terminals: Mutex::new(tm),
            terminal_events_tx: tx,
            agents: AgentManager::new(),
            worktree_state: Mutex::new(WorktreeState::new(worktree_events_tx.clone())),
            worktree_events_tx,
            db: Mutex::new(db),
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
