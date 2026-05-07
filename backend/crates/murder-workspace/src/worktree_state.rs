//! Worktree state — tracks the content of every file in the workspace.
//!
//! When a file changes (from the file watcher, agent writes, or user edits),
//! we capture the old content before updating the cache. This gives us the
//! "before" state needed for diff views.
//!
//! Architecture:
//! - `content_cache`: PathBuf -> String (last known content of every file)
//! - `changed_files`: PathBuf -> (old_content, new_content, timestamp)
//! - File watcher detects changes → reads new content → stores old→new → emits event
//! - Agent `write_file` → reads old from cache → writes new → stores old→new

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use ignore::WalkBuilder;
use parking_lot::RwLock;
use serde::Serialize;
use tokio::sync::broadcast;

use crate::watcher::{FileEvent, FileEventKind, FileWatcher};

/// Maximum file size to cache (5MB). Larger files are not tracked.
const MAX_FILE_SIZE: u64 = 5 * 1024 * 1024;

/// Debounce window for file watcher events (ms).
const WATCHER_DEBOUNCE_MS: u64 = 100;

/// A tracked file change with before/after content.
#[derive(Debug, Clone, Serialize)]
pub struct FileChange {
    pub path: PathBuf,
    pub old_content: String,
    pub new_content: String,
    pub kind: FileEventKind,
    #[serde(skip)]
    pub timestamp: Instant,
}

/// Worktree event — file content changed.
#[derive(Debug, Clone, Serialize)]
pub struct WorktreeEvent {
    pub method: String,
    pub params: serde_json::Value,
}

impl WorktreeEvent {
    pub fn file_changed(path: &str, old_content: &str, new_content: &str) -> Self {
        Self {
            method: "worktree-file-changed".into(),
            params: serde_json::json!({
                "path": path,
                "old_content": old_content,
                "new_content": new_content,
            }),
        }
    }

    pub fn file_deleted(path: &str, old_content: &str) -> Self {
        Self {
            method: "worktree-file-deleted".into(),
            params: serde_json::json!({
                "path": path,
                "old_content": old_content,
            }),
        }
    }

    pub fn file_created(path: &str, new_content: &str) -> Self {
        Self {
            method: "worktree-file-created".into(),
            params: serde_json::json!({
                "path": path,
                "new_content": new_content,
            }),
        }
    }
}

/// Internal state protected by RwLock.
struct Inner {
    /// Last known content of every file we're tracking.
    content_cache: HashMap<PathBuf, String>,
    /// Recent changes (cleared after 5 minutes).
    changed_files: HashMap<PathBuf, FileChange>,
    /// Broadcast channel for worktree events (serialized JSON).
    event_tx: broadcast::Sender<String>,
}

/// Manages the worktree state: file content cache + change tracking.
pub struct WorktreeState {
    inner: Arc<RwLock<Inner>>,
    _watcher: Option<FileWatcher>,
    cleanup_handle: Option<std::thread::JoinHandle<()>>,
}

impl WorktreeState {
    pub fn new(event_tx: broadcast::Sender<String>) -> Self {
        Self {
            inner: Arc::new(RwLock::new(Inner {
                content_cache: HashMap::new(),
                changed_files: HashMap::new(),
                event_tx,
            })),
            _watcher: None,
            cleanup_handle: None,
        }
    }

    /// Open a workspace: scan all files and cache their content.
    pub fn open_workspace(&mut self, root: &Path) {
        self.clear();

        // Start file watcher
        let inner = Arc::clone(&self.inner);
        let watcher = FileWatcher::on_change(root, move |events| {
            Self::handle_watcher_events(&inner, events);
        })
        .unwrap();

        // Scan and cache all files
        self.scan_directory(root);

        self._watcher = Some(watcher);
        self.start_cleanup_task();
    }

    /// Get the known content of a file (from cache or disk).
    pub fn get_content(&self, path: &Path) -> Option<String> {
        // Check cache first
        if let Some(content) = self.inner.read().content_cache.get(path) {
            return Some(content.clone());
        }
        // Fall back to disk
        std::fs::read_to_string(path).ok()
    }

    /// Record a file write: capture old content before updating cache with new content.
    /// Returns the old content if the file existed before.
    pub fn record_write(&self, path: &Path, new_content: &str) -> Option<String> {
        let mut inner = self.inner.write();

        let old_content = inner.content_cache.get(path).cloned();

        // Record the change
        if let Some(ref old) = old_content {
            let change = FileChange {
                path: path.to_path_buf(),
                old_content: old.clone(),
                new_content: new_content.to_string(),
                kind: FileEventKind::Modified,
                timestamp: Instant::now(),
            };
            inner.changed_files.insert(path.to_path_buf(), change);

            // Emit event
            let event = WorktreeEvent::file_changed(
                &path.to_string_lossy(),
                old,
                new_content,
            );
            if let Ok(json) = serde_json::to_string(&event) {
                let _ = inner.event_tx.send(json);
            }
        }

        // Update cache
        if new_content.len() <= MAX_FILE_SIZE as usize {
            inner
                .content_cache
                .insert(path.to_path_buf(), new_content.to_string());
        }

        old_content
    }

    /// Get the "before" content for a file that was recently changed.
    /// This is used by the chat panel to show diffs for agent edits.
    pub fn get_before_content(&self, path: &Path) -> Option<String> {
        self.inner
            .read()
            .changed_files
            .get(path)
            .map(|c| c.old_content.clone())
    }

    /// Get the full change record for a file.
    pub fn get_change(&self, path: &Path) -> Option<FileChange> {
        self.inner
            .read()
            .changed_files
            .get(path)
            .cloned()
    }

    /// Clear all state (call before opening a new workspace).
    pub fn clear(&mut self) {
        let mut inner = self.inner.write();
        inner.content_cache.clear();
        inner.changed_files.clear();
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    fn scan_directory(&self, root: &Path) {
        // Use ignore::WalkBuilder for gitignore-respecting file scan.
        // Falls back to manual read_dir if root doesn't exist (shouldn't happen).
        let walk = WalkBuilder::new(root)
            .hidden(false)
            .git_global(true)
            .git_ignore(true)
            .git_exclude(true)
            .build();
        for entry in walk {
            let Ok(entry) = entry else { continue };
            let path = entry.path();
            if Self::should_ignore(path) {
                continue;
            }
            if entry.file_type().is_some_and(|ft| ft.is_file()) {
                // Cache file content if within size limit
                if let Ok(meta) = path.metadata() {
                    if meta.len() > MAX_FILE_SIZE {
                        continue;
                    }
                    if let Ok(content) = std::fs::read_to_string(path) {
                        self.inner
                            .write()
                            .content_cache
                            .insert(path.to_path_buf(), content);
                    }
                }
            }
        }
    }

    fn handle_watcher_events(inner: &Arc<RwLock<Inner>>, events: Vec<FileEvent>) {
        for event in events {
            match event.kind {
                FileEventKind::Created => {
                    if let Ok(content) = std::fs::read_to_string(&event.path) {
                        let mut inner = inner.write();
                        if content.len() <= MAX_FILE_SIZE as usize {
                            inner
                                .content_cache
                                .insert(event.path.clone(), content.clone());
                        }
                        let wt_event = WorktreeEvent::file_created(
                            &event.path.to_string_lossy(),
                            &content,
                        );
                        if let Ok(json) = serde_json::to_string(&wt_event) {
                            let _ = inner.event_tx.send(json);
                        }
                    }
                }
                FileEventKind::Modified | FileEventKind::Renamed => {
                    let mut inner = inner.write();
                    let old_content = inner.content_cache.get(&event.path).cloned();

                    if let Ok(new_content) = std::fs::read_to_string(&event.path) {
                        if let Some(old) = old_content {
                            // Record the change
                            let change = FileChange {
                                path: event.path.clone(),
                                old_content: old.clone(),
                                new_content: new_content.clone(),
                                kind: event.kind,
                                timestamp: Instant::now(),
                            };
                            inner.changed_files.insert(event.path.clone(), change);

                            let wt_event = WorktreeEvent::file_changed(
                                &event.path.to_string_lossy(),
                                &old,
                                &new_content,
                            );
                            if let Ok(json) = serde_json::to_string(&wt_event) {
                                let _ = inner.event_tx.send(json);
                            }
                        }

                        if new_content.len() <= MAX_FILE_SIZE as usize {
                            inner
                                .content_cache
                                .insert(event.path, new_content);
                        }
                    }
                }
                FileEventKind::Deleted => {
                    let mut inner = inner.write();
                    if let Some(old_content) = inner.content_cache.remove(&event.path) {
                        let wt_event = WorktreeEvent::file_deleted(
                            &event.path.to_string_lossy(),
                            &old_content,
                        );
                        if let Ok(json) = serde_json::to_string(&wt_event) {
                            let _ = inner.event_tx.send(json);
                        }
                    }
                }
            }
        }
    }

    fn start_cleanup_task(&mut self) {
        let inner = Arc::clone(&self.inner);
        let handle = std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(60));
                let cutoff = Instant::now() - Duration::from_secs(300); // 5 min
                let mut inner = inner.write();
                inner
                    .changed_files
                    .retain(|_, change| change.timestamp < cutoff);
            }
        });
        self.cleanup_handle = Some(handle);
    }

    fn should_ignore(path: &Path) -> bool {
        static IGNORED: &[&str] = &[
            ".git", "node_modules", "target", "dist", "build", "out",
            "__pycache__", ".next", ".cache",
        ];
        for component in path.components() {
            if let Some(name) = component.as_os_str().to_str() {
                if IGNORED.contains(&name) {
                    return true;
                }
            }
        }
        false
    }
}
