use crate::changelog::ChangeLog;
use crate::models::*;
use chrono::Utc;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{broadcast, RwLock, Mutex as TokioMutex};
use tracing::info;

// ── Terminal session types ────────────────────────────────────────────

/// Commands sent from the PTY WebSocket handler into the PTY writer task.
pub enum TerminalCommand {
    Input(Vec<u8>),
    Resize(u16, u16),
}

/// Live state for one running terminal session.
pub struct TerminalSession {
    /// Broadcast PTY output bytes to all connected WebSocket clients.
    pub output_tx: broadcast::Sender<Vec<u8>>,
    /// Send input/resize into the PTY writer task.
    pub input_tx: tokio::sync::mpsc::UnboundedSender<TerminalCommand>,
    /// Working directory the claude process was started in.
    pub working_dir: String,
}

pub type TerminalStore = Arc<TokioMutex<HashMap<String, TerminalSession>>>;

/// Shared application state accessible from all HTTP handlers.
#[derive(Clone)]
pub struct AppState {
    pub inner: Arc<RwLock<AppStateInner>>,
    /// Broadcast channel for WebSocket events
    pub event_tx: broadcast::Sender<String>,
    /// Active terminal (PTY) sessions spawned by the dashboard.
    pub terminal_store: TerminalStore,
    /// Signal the auditor to wake up early (e.g. after a correction attempt)
    pub audit_trigger: Arc<tokio::sync::Notify>,
}

pub struct AppStateInner {
    pub session: SessionInfo,
    pub config: crate::config::WatchdogConfig,
    pub change_log: ChangeLog,
    pub tracked_files: HashMap<String, TrackedFile>,
    /// Stores edit history per file: list of (old_string, new_string) pairs
    pub file_edits: HashMap<String, Vec<(String, String)>>,
    /// Stores the initial content for created files
    pub file_creates: HashMap<String, String>,
    /// Active drift events — keyed by file path
    pub active_drifts: HashMap<String, DriftEvent>,
    /// Path to the Claude Code transcript for this session
    pub transcript_path: Option<String>,
    /// Whether we've already loaded history from the transcript
    pub transcript_loaded: bool,
    /// Rules engine for deterministic checks
    pub rules_engine: crate::rules::RulesEngine,
    /// Set to true once we've learned the agent session ID from the first hook event.
    pub session_discovered: bool,
    /// Current context window usage percentage (0-100)
    pub context_percent: u8,
    /// Whether the context warning has already been delivered (fire once)
    pub context_warned: bool,
    /// Whether the context block is active
    pub context_blocked: bool,
    /// Whether the agent has written a handoff document (lifts block)
    pub handoff_written: bool,
    /// Handoff lifecycle record for the current session
    pub handoff: Option<crate::models::HandoffRecord>,
    /// Last time we refreshed the context percentage
    pub last_context_refresh: Option<Instant>,
    /// Registered session IDs that this server is observing
    pub observed_sessions: std::collections::HashSet<String>,
    /// Hash of combined spec content — used to detect spec changes and re-audit drifted files
    pub last_spec_hash: u64,
    /// Per-session config overrides (enforcement_enabled, audit_mode)
    pub session_configs: HashMap<String, SessionConfig>,
    /// Persistent lock/watch store (shared, mutex-guarded)
    pub lockwatch: std::sync::Arc<std::sync::Mutex<crate::lockwatch::LockWatchStore>>,
}

/// Per-session configuration overrides.
/// When set, these take precedence over global config for the specific session.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionConfig {
    pub enforcement_enabled: Option<bool>,
    pub audit_mode: Option<String>,
}

impl AppState {
    pub fn new(
        config: crate::config::WatchdogConfig,
        session_dir: &Path,
    ) -> std::io::Result<Self> {
        let change_log = ChangeLog::new(session_dir)?;
        let session_id = uuid::Uuid::new_v4().to_string();

        let session = SessionInfo {
            id: session_id,
            agent_session_id: None,
            spec_path: config.spec_path.clone(),
            status: SessionStatus::Waiting,
            started_at: Utc::now(),
            port: config.port,
            project_dir: config.project_dir.clone(),
            files_touched: 0,
            files_created: 0,
            files_modified: 0,
            files_deleted: 0,
        };

        let (event_tx, _) = broadcast::channel(256);

        // Load deterministic rules if rules.yml exists
        let mut rules_engine = crate::rules::RulesEngine::new();
        // Set trail persistence path
        let trail_path = std::path::Path::new(&config.project_dir)
            .join(".watchdog").join("audit_trail.jsonl");
        rules_engine.set_trail_path(trail_path);

        let rules_path = std::path::Path::new(&config.project_dir).join("specs").join("rules.yml");
        if rules_path.exists() {
            if let Err(e) = rules_engine.load_from_file(&rules_path) {
                tracing::warn!("Failed to load rules: {}", e);
            }
        }
        // Also check .watchdog/rules.yml
        let alt_rules_path = std::path::Path::new(&config.project_dir).join(".watchdog").join("rules.yml");
        if alt_rules_path.exists() {
            if let Err(e) = rules_engine.load_from_file(&alt_rules_path) {
                tracing::warn!("Failed to load rules: {}", e);
            }
        }

        // Reconstruct active_drifts from persisted audit trail
        let reconstructed = reconstruct_active_drifts(rules_engine.get_trail());

        if !reconstructed.active.is_empty() {
            info!("Reconstructed {} active drifts from audit trail", reconstructed.active.len());
        }

        // Write issue_resolved entries for stale issues (file deleted)
        for (issue_id, file_path) in &reconstructed.stale_issues {
            info!("Auto-resolving stale issue {} (file deleted: {})", issue_id, file_path);
            rules_engine.record_external(crate::rules::AuditTrailEntry {
                timestamp: Utc::now(),
                finding: "aligned".to_string(),
                action: "observed".to_string(),
                source: "semantic".to_string(),
                rule_type: "semantic_audit".to_string(),
                file_path: file_path.clone(),
                tool_name: "LLM Auditor".to_string(),
                reason: "Drift auto-resolved: file no longer exists".to_string(),
                details: serde_json::json!({ "resolution": "file_deleted_on_startup" }),
                rule_quote: String::new(),
                enforcement: false,
                issue_id: Some(issue_id.clone()),
                event_type: Some("issue_resolved".to_string()),
                agent_session_id: None,
            });
        }

        let active_drifts = reconstructed.active;

        let lockwatch_store = crate::lockwatch::LockWatchStore::load();

        let mut state = AppStateInner {
            session,
            config: config.clone(),
            change_log,
            tracked_files: HashMap::new(),
            file_edits: HashMap::new(),
            file_creates: HashMap::new(),
            active_drifts,
            transcript_path: None,
            transcript_loaded: false,
            rules_engine,
            session_discovered: false,
            context_percent: 0,
            context_warned: false,
            context_blocked: false,
            handoff_written: false,
            handoff: None,
            last_context_refresh: None,
            observed_sessions: std::collections::HashSet::new(),
            last_spec_hash: 0,
            session_configs: HashMap::new(),
            lockwatch: std::sync::Arc::new(std::sync::Mutex::new(lockwatch_store)),
        };

        // Files populate through hooks during active observation — no transcript pre-loading.
        // This ensures each session only shows files changed while the watchdog was watching.
        if false {
            let transcript_path = std::path::PathBuf::new();
            let transcript_session_id: Option<String> = None;
            let _ = &config.project_dir;
            info!("Found transcript at startup: {}", transcript_path.display());
            let ops = crate::transcript::parse_transcript(&transcript_path);

            for op in ops {
                let is_modifying = matches!(op.operation,
                    FileOperation::Create | FileOperation::Modify | FileOperation::Delete);
                if !is_modifying { continue; }

                let dir = std::path::Path::new(&op.file_path)
                    .parent()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default();

                if !state.tracked_files.contains_key(&op.file_path) {
                    state.session.files_touched += 1;
                    match op.operation {
                        FileOperation::Create => state.session.files_created += 1,
                        FileOperation::Modify => state.session.files_modified += 1,
                        FileOperation::Delete => state.session.files_deleted += 1,
                        _ => {}
                    }
                }

                let op_change_size = if let Some(ref content) = op.write_content {
                    content.lines().count()
                } else if let Some((ref old_str, ref new_str)) = op.edit_pair {
                    old_str.lines().count() + new_str.lines().count()
                } else {
                    0
                };

                let prev_size = state.tracked_files.get(&op.file_path).map(|t| t.change_size).unwrap_or(0);

                let tracked = TrackedFile {
                    path: op.file_path.clone(),
                    operation: op.operation,
                    timestamp: op.timestamp,
                    audit_status: "pending".to_string(),
                    change_size: prev_size + op_change_size,
                    directory: dir,
                    imports: vec![],
                    session_id: transcript_session_id.clone(),
                };
                state.tracked_files.insert(op.file_path.clone(), tracked);

                if let Some((old_str, new_str)) = op.edit_pair {
                    state.file_edits.entry(op.file_path.clone()).or_default().push((old_str, new_str));
                }
                if let Some(content) = op.write_content {
                    state.file_creates.insert(op.file_path.clone(), content);
                }
            }

            if !state.tracked_files.is_empty() {
                // Remove files that no longer exist on disk (deleted in previous session)
                let before = state.tracked_files.len();
                state.tracked_files.retain(|path, _| std::path::Path::new(path).exists());
                let removed = before - state.tracked_files.len();
                if removed > 0 {
                    info!("Filtered out {} deleted files from transcript pre-load", removed);
                }

                scan_references(&mut state.tracked_files);
                state.session.status = SessionStatus::Observing;
                state.transcript_loaded = true;
                state.transcript_path = Some(transcript_path.to_string_lossy().to_string());
                info!("Pre-loaded {} tracked files from transcript", state.tracked_files.len());
            }
        }

        Ok(Self {
            event_tx,
            inner: Arc::new(RwLock::new(state)),
            terminal_store: Arc::new(TokioMutex::new(HashMap::new())),
            audit_trigger: Arc::new(tokio::sync::Notify::new()),
        })
    }

    /// Record a PostToolUse event. Returns the session ID if this is the first event.
    pub async fn record_event(&self, payload: &HookPayload) {
        let mut state = self.inner.write().await;

        // Learn session ID and transcript path from first event
        if !state.session_discovered {
            state.session.agent_session_id = Some(payload.session_id.clone());
            state.session.status = SessionStatus::Observing;
            state.session_discovered = true;
            state.transcript_path = payload.transcript_path.clone();
            info!(
                "Session discovered: agent_session_id={}",
                payload.session_id
            );

            // Load history from transcript if available
            if let Some(ref tp) = payload.transcript_path {
                if !state.transcript_loaded {
                    let path = std::path::Path::new(tp);
                    let ops = crate::transcript::parse_transcript(path);
                    for op in ops {
                        // Only track file-modifying operations
                        let is_modifying = matches!(op.operation,
                            FileOperation::Create | FileOperation::Modify | FileOperation::Delete);
                        if !is_modifying { continue; }

                        let dir = std::path::Path::new(&op.file_path)
                            .parent()
                            .map(|p| p.to_string_lossy().to_string())
                            .unwrap_or_default();

                        // Track the file
                        if !state.tracked_files.contains_key(&op.file_path) {
                            state.session.files_touched += 1;
                            match op.operation {
                                FileOperation::Create => state.session.files_created += 1,
                                FileOperation::Modify => state.session.files_modified += 1,
                                FileOperation::Delete => state.session.files_deleted += 1,
                                _ => {}
                            }
                        }

                        let op_change_size = if let Some(ref content) = op.write_content {
                            content.lines().count()
                        } else if let Some((ref old_str, ref new_str)) = op.edit_pair {
                            old_str.lines().count() + new_str.lines().count()
                        } else {
                            0
                        };

                        let prev_size = state.tracked_files.get(&op.file_path).map(|t| t.change_size).unwrap_or(0);

                        let tracked = TrackedFile {
                            path: op.file_path.clone(),
                            operation: op.operation,
                            timestamp: op.timestamp,
                            audit_status: "pending".to_string(),
                            change_size: prev_size + op_change_size,
                            directory: dir,
                            imports: vec![],
                            session_id: Some(payload.session_id.clone()),
                        };
                        state.tracked_files.insert(op.file_path.clone(), tracked);

                        // Store edit/create data
                        if let Some((old_str, new_str)) = op.edit_pair {
                            state.file_edits.entry(op.file_path.clone()).or_default().push((old_str, new_str));
                        }
                        if let Some(content) = op.write_content {
                            state.file_creates.insert(op.file_path.clone(), content);
                        }
                    }
                    state.transcript_loaded = true;
                    info!("Loaded {} tracked files from transcript", state.tracked_files.len());

                    // Post-load: scan all files for definitions and references
                    scan_references(&mut state.tracked_files);
                    info!("Reference scan complete");
                }
            }
        }

        // Create and append change log entry
        let entry = crate::changelog::create_entry(
            &payload.session_id,
            &payload.tool_name,
            &payload.tool_input,
            payload.tool_response.as_ref(),
        );

        let is_modifying = matches!(entry.operation,
            FileOperation::Create | FileOperation::Modify | FileOperation::Delete);
        let is_read = matches!(entry.operation, FileOperation::Read);

        // Skip entries with no meaningful file path (e.g. Bash commands like echo, curl)
        if let Some(ref path) = entry.file_path {
            if path == "null" || path.is_empty() {
                if let Err(e) = state.change_log.append(&entry) {
                    tracing::error!("Failed to write change log: {}", e);
                }
                return;
            }
        }

        if let Some(ref path) = entry.file_path {
            if !is_modifying && !is_read {
                // Skip unknown/bash-only operations
                if let Err(e) = state.change_log.append(&entry) {
                    tracing::error!("Failed to write change log: {}", e);
                }
                print_activity(&entry);
                return;
            }

            let dir = Path::new(path)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();

            // Calculate change size from tool input
            let change_size = match payload.tool_name.as_str() {
                "Write" => {
                    payload.tool_input.get("content")
                        .and_then(|v| v.as_str())
                        .map(|s| s.lines().count())
                        .unwrap_or(0)
                }
                "Edit" => {
                    let old_lines = payload.tool_input.get("old_string")
                        .and_then(|v| v.as_str())
                        .map(|s| s.lines().count())
                        .unwrap_or(0);
                    let new_lines = payload.tool_input.get("new_string")
                        .and_then(|v| v.as_str())
                        .map(|s| s.lines().count())
                        .unwrap_or(0);
                    old_lines + new_lines
                }
                _ => 0,
            };

            // Accumulate change_size if file was already tracked
            let prev_size = state.tracked_files.get(path).map(|t| t.change_size).unwrap_or(0);

            if is_read {
                // For reads: update timestamp but don't overwrite operation or counters
                if let Some(existing) = state.tracked_files.get_mut(path) {
                    existing.timestamp = entry.timestamp;
                } else {
                    // First time seeing this file — add as read
                    let prev_imports = vec![];
                    let tracked = TrackedFile {
                        path: path.clone(),
                        operation: FileOperation::Read,
                        timestamp: entry.timestamp,
                        audit_status: "pending".to_string(),
                        change_size: 0,
                        directory: dir,
                        imports: prev_imports,
                        session_id: Some(payload.session_id.clone()),
                    };
                    state.tracked_files.insert(path.clone(), tracked);
                }
            } else {
                // For modifications: full tracking with counters
                let prev_imports = state.tracked_files.get(path).map(|t| t.imports.clone()).unwrap_or_default();

                let tracked = TrackedFile {
                    path: path.clone(),
                    operation: entry.operation.clone(),
                    timestamp: entry.timestamp,
                    audit_status: "pending".to_string(),
                    change_size: prev_size + change_size,
                    directory: dir,
                    imports: prev_imports,
                    session_id: Some(payload.session_id.clone()),
                };

                if let Some(existing) = state.tracked_files.get(path) {
                    // File already tracked — adjust counters if operation changed
                    if matches!(entry.operation, FileOperation::Delete)
                        && !matches!(existing.operation, FileOperation::Delete)
                    {
                        // Decrement the old operation counter
                        match existing.operation {
                            FileOperation::Create => state.session.files_created = state.session.files_created.saturating_sub(1),
                            FileOperation::Modify => state.session.files_modified = state.session.files_modified.saturating_sub(1),
                            _ => {}
                        }
                        state.session.files_deleted += 1;
                    }
                } else {
                    state.session.files_touched += 1;
                    match entry.operation {
                        FileOperation::Create => state.session.files_created += 1,
                        FileOperation::Modify => state.session.files_modified += 1,
                        FileOperation::Delete => state.session.files_deleted += 1,
                        _ => {}
                    }
                }

                let has_drift = state.active_drifts.contains_key(path);
                // Insert first so audit_status = "pending" before we wake the auditor
                state.tracked_files.insert(path.clone(), tracked);
                // Wake the auditor immediately when the agent corrects a drifted file
                if has_drift {
                    drop(state);
                    self.audit_trigger.notify_one();
                    return;
                }
            }

            // Detect handoff document creation (Write to a file matching *handoff* or *HANDOFF*)
            if matches!(entry.operation, FileOperation::Create | FileOperation::Modify) {
                if let Some(ref p) = entry.file_path {
                    let file_name_lower = Path::new(p)
                        .file_name()
                        .and_then(|f| f.to_str())
                        .unwrap_or("")
                        .to_lowercase();
                    if file_name_lower.contains("handoff") {
                        state.handoff_written = true;
                        info!("Handoff document detected: {}", p);
                    }
                }
            }

            // Store edit/create data and rescan references (only for modifications)
            if is_modifying {
                match payload.tool_name.as_str() {
                    "Edit" => {
                        let old_str = payload.tool_input.get("old_string")
                            .and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let new_str = payload.tool_input.get("new_string")
                            .and_then(|v| v.as_str()).unwrap_or("").to_string();
                        state.file_edits.entry(path.clone()).or_default().push((old_str, new_str));
                    }
                    "Write" => {
                        let content = payload.tool_input.get("content")
                            .and_then(|v| v.as_str()).unwrap_or("").to_string();
                        state.file_creates.insert(path.clone(), content);
                    }
                    _ => {}
                }
                scan_references(&mut state.tracked_files);
            }
        }

        // Append to change log file
        if let Err(e) = state.change_log.append(&entry) {
            tracing::error!("Failed to write change log: {}", e);
        }

        // Print live activity
        print_activity(&entry);

        // Broadcast WebSocket event
        if let Some(ref path) = entry.file_path {
            let tracked = state.tracked_files.get(path);
            let event = serde_json::json!({
                "type": "file_activity",
                "timestamp": entry.timestamp,
                "path": path,
                "operation": entry.operation,
                "tool_name": entry.tool_name,
                "change_size": tracked.map(|t| t.change_size).unwrap_or(0),
                "directory": tracked.map(|t| t.directory.clone()).unwrap_or_default(),
                "imports": tracked.map(|t| &t.imports).cloned().unwrap_or_default(),
            });
            let _ = self.event_tx.send(event.to_string());
        }
    }

    pub async fn get_session_info(&self) -> SessionInfo {
        self.inner.read().await.session.clone()
    }

    pub async fn get_file_edits(&self, path: &str) -> Vec<(String, String)> {
        self.inner.read().await.file_edits.get(path).cloned().unwrap_or_default()
    }

    pub async fn get_file_create_content(&self, path: &str) -> Option<String> {
        self.inner.read().await.file_creates.get(path).cloned()
    }

    pub async fn get_tracked_files(&self) -> Vec<TrackedFile> {
        self.inner
            .read()
            .await
            .tracked_files
            .values()
            .cloned()
            .collect()
    }

    pub async fn get_config(&self) -> crate::config::WatchdogConfig {
        self.inner.read().await.config.clone()
    }

    pub async fn set_status(&self, status: SessionStatus) {
        self.inner.write().await.session.status = status;
    }

    /// Get effective enforcement_enabled for a session, falling back to global config.
    pub async fn get_enforcement_for_session(&self, session_id: &str) -> bool {
        let inner = self.inner.read().await;
        if let Some(sc) = inner.session_configs.get(session_id) {
            if let Some(enabled) = sc.enforcement_enabled {
                return enabled;
            }
        }
        inner.config.enforcement_enabled
    }

    /// Get effective audit_mode for a session, falling back to global config.
    pub async fn get_audit_mode_for_session(&self, session_id: &str) -> String {
        let inner = self.inner.read().await;
        if let Some(sc) = inner.session_configs.get(session_id) {
            if let Some(ref mode) = sc.audit_mode {
                return mode.clone();
            }
        }
        inner.config.audit_mode.clone()
    }
}

impl AppStateInner {
    /// Get effective enforcement_enabled for a session, falling back to global config.
    pub fn enforcement_for_session(&self, session_id: &str) -> bool {
        if let Some(sc) = self.session_configs.get(session_id) {
            if let Some(enabled) = sc.enforcement_enabled {
                return enabled;
            }
        }
        self.config.enforcement_enabled
    }

    /// Get effective audit_mode for a session, falling back to global config.
    pub fn audit_mode_for_session(&self, session_id: &str) -> String {
        if let Some(sc) = self.session_configs.get(session_id) {
            if let Some(ref mode) = sc.audit_mode {
                return mode.clone();
            }
        }
        self.config.audit_mode.clone()
    }

    /// Refresh the context percentage from .agent.json or transcript tail.
    /// Only refreshes if at least 5 seconds have elapsed since last refresh.
    pub fn refresh_context_percent(&mut self) {
        if let Some(last) = self.last_context_refresh {
            if last.elapsed().as_secs() < 5 {
                return;
            }
        }

        // Option A: Try reading from .agent.json
        if let Some(pct) = self.read_context_from_agent_json() {
            self.context_percent = pct;
            self.last_context_refresh = Some(Instant::now());
            return;
        }

        // Option B: Parse transcript tail
        if let Some(pct) = self.read_context_from_transcript() {
            self.context_percent = pct;
            self.last_context_refresh = Some(Instant::now());
            return;
        }

        self.last_context_refresh = Some(Instant::now());
    }

    /// Read context_pct from ~/.claude/usage/<today>/<pid>.agent.json
    /// When known session IDs are available, filters by session_id to avoid
    /// reading another session's context percentage.
    fn read_context_from_agent_json(&self) -> Option<u8> {
        let home = std::env::var("HOME").ok()?;
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let usage_dir = PathBuf::from(&home).join(".claude").join("usage").join(&today);

        if !usage_dir.exists() {
            return None;
        }

        // Only filter by session_id when we have at least one known session
        let has_known_sessions = self.session.agent_session_id.is_some()
            || !self.observed_sessions.is_empty();

        let entries = std::fs::read_dir(&usage_dir).ok()?;
        let mut latest_pct: Option<(std::time::SystemTime, u8)> = None;

        for entry in entries.flatten() {
            let path = entry.path();
            let name = path.file_name()?.to_str()?;
            if !name.ends_with(".agent.json") {
                continue;
            }

            let content = std::fs::read_to_string(&path).ok()?;
            let value: serde_json::Value = serde_json::from_str(&content).ok()?;

            // Filter by session_id when we know which sessions we're observing
            if has_known_sessions {
                if let Some(file_sid) = value.get("session_id").and_then(|v| v.as_str()) {
                    let is_our_session =
                        self.session.agent_session_id.as_deref() == Some(file_sid)
                        || self.observed_sessions.contains(file_sid);
                    if !is_our_session {
                        continue;
                    }
                }
            }

            if let Some(pct) = value.get("context_pct").and_then(|v| v.as_f64()) {
                let modified = path.metadata().ok()?.modified().ok()?;
                if latest_pct.as_ref().map_or(true, |(t, _)| modified > *t) {
                    latest_pct = Some((modified, pct.min(100.0) as u8));
                }
            }
        }

        latest_pct.map(|(_, pct)| pct)
    }

    /// Read context percentage from the transcript tail by parsing usage data.
    fn read_context_from_transcript(&self) -> Option<u8> {
        let transcript_path = self.transcript_path.as_ref()?;
        let path = Path::new(transcript_path);
        if !path.exists() {
            return None;
        }

        // Read the last ~32KB of the transcript
        let file = std::fs::File::open(path).ok()?;
        let metadata = file.metadata().ok()?;
        let file_len = metadata.len();
        let read_start = if file_len > 32768 { file_len - 32768 } else { 0 };

        use std::io::{Read, Seek, SeekFrom};
        let mut file = file;
        file.seek(SeekFrom::Start(read_start)).ok()?;
        let mut tail = String::new();
        file.read_to_string(&mut tail).ok()?;

        // Parse lines looking for the latest assistant message with usage
        let mut latest_pct: Option<u8> = None;
        for line in tail.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
                // Look for usage data in assistant messages
                if let Some(usage) = value.get("usage") {
                    let input_tokens = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    let cache_read = usage.get("cache_read_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    let total = input_tokens + cache_read;

                    // Determine model limit from model field
                    let model = value.get("model").and_then(|v| v.as_str()).unwrap_or("");
                    let model_limit: u64 = if model.contains("opus") {
                        1_000_000
                    } else if model.contains("haiku") {
                        200_000
                    } else {
                        // Default to sonnet limit
                        200_000
                    };

                    if model_limit > 0 && total > 0 {
                        let pct = ((total as f64 / model_limit as f64) * 100.0).min(100.0) as u8;
                        latest_pct = Some(pct);
                    }
                }
            }
        }

        latest_pct
    }
}

/// Result of reconstructing drifts from the audit trail.
struct ReconstructedDrifts {
    /// Active drifts (unresolved, file still exists)
    active: HashMap<String, DriftEvent>,
    /// Issues that should be marked resolved (file deleted or stale)
    stale_issues: Vec<(String, String)>, // (issue_id, file_path)
}

/// Reconstruct active_drifts from persisted audit trail entries.
/// Groups entries by issue_id, determines which issues are still open,
/// and rebuilds DriftEvent state for unresolved issues.
/// Issues whose files no longer exist are returned as stale for resolution.
fn reconstruct_active_drifts(trail: &[crate::rules::AuditTrailEntry]) -> ReconstructedDrifts {
    let mut drifts: HashMap<String, DriftEvent> = HashMap::new();
    let mut stale_issues: Vec<(String, String)> = Vec::new();

    // Group trail entries by issue_id
    let mut by_issue: HashMap<String, Vec<&crate::rules::AuditTrailEntry>> = HashMap::new();
    for entry in trail {
        if let Some(ref issue_id) = entry.issue_id {
            by_issue.entry(issue_id.clone()).or_default().push(entry);
        }
    }

    for (issue_id, entries) in &by_issue {
        // Check if this issue was already resolved
        let is_resolved = entries.iter().any(|e| {
            e.event_type.as_deref() == Some("issue_resolved")
        });
        if is_resolved {
            continue;
        }

        // Find the initial detection entry
        let detection = entries.iter().find(|e| {
            e.event_type.as_deref() == Some("issue_detected")
        });
        let Some(detection) = detection else { continue };

        // If the file no longer exists, mark as stale for resolution
        if !std::path::Path::new(&detection.file_path).exists() {
            stale_issues.push((issue_id.clone(), detection.file_path.clone()));
            continue;
        }

        // Reset correction attempts and state on reconstruction —
        // a new session should not inherit escalation from previous sessions
        let correction_attempts = 0;
        let state = DriftState::Detected;

        // Extract fields from detection details
        let details = &detection.details;
        let correction = details.get("correction")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let evidence: Vec<String> = details.get("evidence")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let severity = details.get("severity")
            .and_then(|v| v.as_str())
            .unwrap_or("soft_warning")
            .to_string();
        let issue_type = details.get("issue_type")
            .and_then(|v| v.as_str())
            .unwrap_or(&detection.rule_type)
            .to_string();

        let drift_event = DriftEvent {
            id: issue_id.clone(),
            file_path: detection.file_path.clone(),
            finding: "drift".to_string(),
            rule_type: issue_type,
            reason: detection.reason.clone(),
            correction,
            evidence,
            severity,
            source: detection.source.clone(),
            state,
            detected_at: detection.timestamp,
            notified_at: None,
            resolved_at: None,
            correction_attempts,
        };

        drifts.insert(detection.file_path.clone(), drift_event);
    }

    ReconstructedDrifts { active: drifts, stale_issues }
}

/// Find the most recent transcript file for the given project directory.
/// Find ALL transcript files for a project directory.
fn find_all_transcripts(project_dir: &str) -> Vec<PathBuf> {
    let home = match std::env::var("HOME") {
        Ok(h) => h,
        Err(_) => return vec![],
    };
    let project_hash = project_dir.replace('/', "-");
    let project_claude_dir = PathBuf::from(&home).join(".claude").join("projects").join(&project_hash);
    if !project_claude_dir.exists() {
        return vec![];
    }

    let mut transcripts = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&project_claude_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                transcripts.push(path);
            }
        }
    }
    transcripts
}

fn find_latest_transcript(project_dir: &str) -> Option<PathBuf> {
    // Claude Code stores transcripts at ~/.claude/projects/<hash>/<session-id>.jsonl
    // The hash is derived from the project path
    let home = std::env::var("HOME").ok()?;
    let claude_projects = PathBuf::from(&home).join(".claude").join("projects");

    if !claude_projects.exists() {
        return None;
    }

    // The project hash replaces / with -
    // e.g., /Users/foo/project -> -Users-foo-project
    let project_hash = project_dir.replace('/', "-");

    let project_claude_dir = claude_projects.join(&project_hash);
    if !project_claude_dir.exists() {
        return None;
    }

    // Find the most recent .jsonl file
    let mut latest: Option<(PathBuf, std::time::SystemTime)> = None;

    if let Ok(entries) = std::fs::read_dir(&project_claude_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                if let Ok(meta) = path.metadata() {
                    if let Ok(modified) = meta.modified() {
                        if latest.as_ref().map_or(true, |(_, t)| modified > *t) {
                            latest = Some((path, modified));
                        }
                    }
                }
            }
        }
    }

    latest.map(|(path, _)| path)
}

/// Scan all tracked files for symbol definitions and cross-references.
fn scan_references(tracked_files: &mut HashMap<String, TrackedFile>) {
    use crate::imports::{extract_definitions, find_references};

    // Step 1: Extract definitions from each file
    let mut all_symbols: Vec<(String, String)> = vec![]; // (symbol_name, defining_file_path)
    let mut file_contents: HashMap<String, String> = HashMap::new();

    for (path, _) in tracked_files.iter() {
        if let Ok(content) = std::fs::read_to_string(path) {
            let defs = extract_definitions(path, &content);
            for def in &defs {
                all_symbols.push((def.name.clone(), path.clone()));
            }
            file_contents.insert(path.clone(), content);
        }
    }

    let symbol_names: Vec<String> = all_symbols.iter().map(|(name, _)| name.clone()).collect();

    // Step 2: For each file, find which symbols it references
    for (path, tracked) in tracked_files.iter_mut() {
        if let Some(content) = file_contents.get(path) {
            let refs = find_references(content, &symbol_names);

            // Map referenced symbols to the files that define them (excluding self)
            let mut referenced_files: Vec<String> = vec![];
            for ref_name in &refs {
                for (sym_name, def_path) in &all_symbols {
                    if sym_name == ref_name && def_path != path {
                        // Store the symbol name as the "import" (it's actually a reference)
                        if !referenced_files.contains(ref_name) {
                            referenced_files.push(ref_name.clone());
                        }
                    }
                }
            }
            tracked.imports = referenced_files;
        }
    }
}

fn print_activity(entry: &ChangeLogEntry) {
    let op = match entry.operation {
        FileOperation::Create => "\x1b[32m CREATE\x1b[0m",
        FileOperation::Modify => "\x1b[33m MODIFY\x1b[0m",
        FileOperation::Delete => "\x1b[31m DELETE\x1b[0m",
        FileOperation::Read => "\x1b[36m   READ\x1b[0m",
        FileOperation::Bash => "\x1b[35m   BASH\x1b[0m",
        FileOperation::Unknown => "\x1b[90m    ???\x1b[0m",
    };

    let path = entry
        .file_path
        .as_deref()
        .unwrap_or(&entry.tool_name);

    let time = entry.timestamp.format("%H:%M:%S");
    eprintln!("  [{time}] {op}  {path}");
}

/// Get the session data directory path.
pub fn session_dir(project_dir: &Path, session_id: &str) -> PathBuf {
    project_dir
        .join(".watchdog")
        .join("sessions")
        .join(session_id)
}

/// Write a PID file so we can find/stop the running server later.
pub fn write_pid_file(project_dir: &Path, port: u16) -> std::io::Result<()> {
    let pid_dir = project_dir.join(".watchdog");
    std::fs::create_dir_all(&pid_dir)?;
    let pid_file = pid_dir.join("watchdog.pid");
    let content = serde_json::json!({
        "pid": std::process::id(),
        "port": port,
        "started_at": Utc::now().to_rfc3339(),
    });
    std::fs::write(&pid_file, serde_json::to_string_pretty(&content).unwrap())?;
    Ok(())
}

/// Read the PID file to find a running watchdog.
pub fn read_pid_file(project_dir: &Path) -> Option<(u32, u16)> {
    let pid_file = project_dir.join(".watchdog").join("watchdog.pid");
    if !pid_file.exists() {
        return None;
    }
    let content = std::fs::read_to_string(&pid_file).ok()?;
    let value: serde_json::Value = serde_json::from_str(&content).ok()?;
    let pid = value.get("pid")?.as_u64()? as u32;
    let port = value.get("port")?.as_u64()? as u16;
    Some((pid, port))
}

/// Remove the PID file.
pub fn remove_pid_file(project_dir: &Path) {
    let pid_file = project_dir.join(".watchdog").join("watchdog.pid");
    let _ = std::fs::remove_file(&pid_file);
}
