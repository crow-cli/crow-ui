//! Minimal flat key-value settings store backed by a JSON file.
//!
//! Uses dot-notation keys (e.g. `"editor.fontSize"`) to match the
//! crow-ui settings convention without the full layered store.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// Simple persistent settings store.
pub struct SettingsStore {
    data: HashMap<String, Value>,
    path: PathBuf,
}

impl SettingsStore {
    /// Load from disk if the file exists, otherwise start empty.
    pub fn load(path: &Path) -> Self {
        let data = if path.exists() {
            std::fs::read_to_string(path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            HashMap::new()
        };
        Self {
            data,
            path: path.to_path_buf(),
        }
    }

    /// Get a value by dot-notation key.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.data.get(key)
    }

    /// Set a value by dot-notation key and persist to disk.
    pub fn set(&mut self, key: &str, value: Value) -> Result<(), String> {
        self.data.insert(key.to_owned(), value);
        self.save()
    }

    /// Return all stored key-value pairs.
    pub fn all(&self) -> &HashMap<String, Value> {
        &self.data
    }

    fn save(&self) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let json = serde_json::to_string_pretty(&self.data)
            .map_err(|e| format!("failed to serialize settings: {e}"))?;
        std::fs::write(&self.path, json)
            .map_err(|e| format!("failed to write settings: {e}"))
    }
}
