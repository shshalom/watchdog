// Persists to ~/.config/watchdog/locks.json
// Structure:
//   { "locks": ["/path/a", "/path/b"], "watches": ["/path/c"] }
//
// Path matching for is_locked/is_watched:
//   - Exact match: path == locked_path
//   - Prefix match: path starts with locked_path + "/"
//   (so locking /home/user/project locks all files inside it)

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LockWatchStore {
    #[serde(default)]
    pub locks: HashSet<String>,
    #[serde(default)]
    pub watches: HashSet<String>,
}

impl LockWatchStore {
    /// Load from config_path(), returning Default on any error.
    pub fn load() -> Self {
        let path = Self::config_path();
        let Ok(content) = std::fs::read_to_string(&path) else {
            return Self::default();
        };
        serde_json::from_str(&content).unwrap_or_default()
    }

    /// Write to config_path(), silently ignoring errors.
    pub fn save(&self) {
        let path = Self::config_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(&path, json);
        }
    }

    /// Returns `~/.config/watchdog/locks.json`.
    pub fn config_path() -> std::path::PathBuf {
        let base = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        std::path::PathBuf::from(base)
            .join(".config")
            .join("watchdog")
            .join("locks.json")
    }

    /// True if `path` exactly matches a locked entry, or starts with one + "/".
    pub fn is_locked(&self, path: &str) -> bool {
        self.locks.iter().any(|locked| {
            path == locked || path.starts_with(&format!("{}/", locked))
        })
    }

    /// True if `path` exactly matches a watched entry, or starts with one + "/".
    pub fn is_watched(&self, path: &str) -> bool {
        self.watches.iter().any(|watched| {
            path == watched || path.starts_with(&format!("{}/", watched))
        })
    }

    pub fn set_lock(&mut self, path: &str, locked: bool) {
        if locked {
            self.locks.insert(path.to_string());
        } else {
            self.locks.remove(path);
        }
        self.save();
    }

    pub fn set_watch(&mut self, path: &str, watched: bool) {
        if watched {
            self.watches.insert(path.to_string());
        } else {
            self.watches.remove(path);
        }
        self.save();
    }
}
