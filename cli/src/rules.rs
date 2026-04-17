use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tracing::info;

// ── Rule Definitions ──

#[derive(Debug, Clone, Deserialize)]
pub struct RulesConfig {
    pub rules: Vec<Rule>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Rule {
    #[serde(rename = "type")]
    pub rule_type: String,
    #[serde(default)]
    pub extensions: Vec<String>,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub patterns: Vec<String>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default, rename = "subagentBypass")]
    pub subagent_bypass: bool,
    // context_threshold fields
    #[serde(default, rename = "warn_percent")]
    pub warn_percent: Option<u8>,
    #[serde(default, rename = "block_percent")]
    pub block_percent: Option<u8>,
    #[serde(default, rename = "warn_message")]
    pub warn_message: Option<String>,
    #[serde(default, rename = "block_message")]
    pub block_message: Option<String>,
}

// ── Audit Trail Entry ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditTrailEntry {
    pub timestamp: DateTime<Utc>,
    pub finding: String,       // "violation", "drift", "aligned", "concern", "enforcement"
    pub action: String,        // "denied", "warned", "observed"
    pub source: String,        // "deterministic" or "semantic"
    pub rule_type: String,
    pub file_path: String,
    pub tool_name: String,
    pub reason: String,
    pub details: serde_json::Value,
    #[serde(default)]
    pub rule_quote: String,
    #[serde(default)]
    pub enforcement: bool,     // true if enforcement was on when this was recorded
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_type: Option<String>,  // "issue_detected", "change_requested", "agent_responded", "re_evaluated", "issue_resolved", "escalated"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
}

// ── Rules Engine ──

pub struct RulesEngine {
    rules: Vec<Rule>,
    trail: Vec<AuditTrailEntry>,
    trail_path: Option<std::path::PathBuf>,
}

impl RulesEngine {
    pub fn new() -> Self {
        Self {
            rules: Vec::new(),
            trail: Vec::new(),
            trail_path: None,
        }
    }

    /// Set the path for persisting the audit trail
    pub fn set_trail_path(&mut self, path: std::path::PathBuf) {
        self.trail_path = Some(path.clone());
        // Load existing trail from disk
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(&path) {
                for line in content.lines() {
                    if let Ok(entry) = serde_json::from_str::<AuditTrailEntry>(line) {
                        self.trail.push(entry);
                    }
                }
                if !self.trail.is_empty() {
                    tracing::info!("Loaded {} audit trail entries from disk", self.trail.len());
                }
            }
        }
    }

    /// Load rules from a YAML file
    pub fn load_from_file(&mut self, path: &Path) -> Result<(), String> {
        let content = std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read rules file: {}", e))?;
        let config: RulesConfig = serde_yaml::from_str(&content)
            .map_err(|e| format!("Failed to parse rules YAML: {}", e))?;
        self.rules = config.rules;
        info!("Loaded {} deterministic rules from {}", self.rules.len(), path.display());
        Ok(())
    }

    /// Get the current rules
    pub fn rules(&self) -> &[Rule] {
        &self.rules
    }

    /// Check if a file write/edit would violate any rules.
    /// Returns Some(reason) if violated, None if allowed.
    pub fn check_violation(
        &mut self,
        file_path: &str,
        tool_name: &str,
        resulting_lines: usize,
        enforcement: bool,
    ) -> Option<String> {
        let ext = Path::new(file_path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let file_name = Path::new(file_path)
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or("");

        for rule in &self.rules {
            match rule.rule_type.as_str() {
                "max_lines" => {
                    if let Some(limit) = rule.limit {
                        let applies = rule.extensions.iter().any(|e| {
                            e == "*" || e.to_lowercase() == ext
                        });

                        if applies && resulting_lines > limit {
                            let reason = rule.message.clone().unwrap_or_else(|| {
                                format!("File exceeds {} line limit", limit)
                            });
                            let full_reason = format!(
                                "{} — '{}' would have {} lines (limit: {})",
                                reason, file_name, resulting_lines, limit
                            );

                            // Record in audit trail
                            let rule_quote = rule.message.clone()
                                .unwrap_or_else(|| format!("max_lines: {} for .{}", limit, ext));
                            self.record(AuditTrailEntry {
                                timestamp: Utc::now(),
                                finding: "violation".to_string(),
                                action: if enforcement { "denied" } else { "observed" }.to_string(),
                                source: "deterministic".to_string(),
                                rule_type: "max_lines".to_string(),
                                file_path: file_path.to_string(),
                                tool_name: tool_name.to_string(),
                                reason: full_reason.clone(),
                                details: serde_json::json!({
                                    "extension": ext,
                                    "resulting_lines": resulting_lines,
                                    "limit": limit,
                                }),
                                rule_quote,
                                enforcement,
                                issue_id: None,
                                event_type: None,
                                agent_session_id: None,
                            });

                            return Some(full_reason);
                        }
                    }
                }
                "forbidden_path" => {
                    for pattern in &rule.paths {
                        if matches_glob(file_path, pattern) || matches_glob(file_name, pattern) {
                            let reason = rule.message.clone().unwrap_or_else(|| {
                                format!("File matches forbidden path pattern '{}'", pattern)
                            });

                            let rule_quote = rule.message.clone()
                                .unwrap_or_else(|| format!("forbidden_path: {}", pattern));
                            self.record(AuditTrailEntry {
                                timestamp: Utc::now(),
                                finding: "violation".to_string(),
                                action: if enforcement { "denied" } else { "observed" }.to_string(),
                                source: "deterministic".to_string(),
                                rule_type: "forbidden_path".to_string(),
                                file_path: file_path.to_string(),
                                tool_name: tool_name.to_string(),
                                reason: reason.clone(),
                                details: serde_json::json!({
                                    "pattern": pattern,
                                }),
                                rule_quote,
                                enforcement,
                                issue_id: None,
                                event_type: None,
                                agent_session_id: None,
                            });

                            return Some(reason);
                        }
                    }
                }
                _ => {}
            }
        }

        // Record allowed action
        self.record(AuditTrailEntry {
            timestamp: Utc::now(),
            finding: "aligned".to_string(),
            action: "observed".to_string(),
            source: "deterministic".to_string(),
            rule_type: "none".to_string(),
            file_path: file_path.to_string(),
            tool_name: tool_name.to_string(),
            reason: "No rule violations".to_string(),
            details: serde_json::json!({
                "resulting_lines": resulting_lines,
            }),
            rule_quote: String::new(),
            enforcement,
            issue_id: None,
            event_type: None,
            agent_session_id: None,
        });

        None
    }

    /// Check if a Bash command violates any forbidden_command rules.
    /// Returns Some(reason) if violated, None if allowed.
    pub fn check_command_violation(
        &mut self,
        command: &str,
        tool_name: &str,
        enforcement: bool,
        caller_session_id: &str,
        main_session_id: Option<&str>,
    ) -> Option<String> {
        for rule in &self.rules {
            if rule.rule_type != "forbidden_command" {
                continue;
            }

            for pattern in &rule.patterns {
                if command.contains(pattern.as_str()) {
                    // Check subagent bypass — WATCHDOG_BYPASS=1 prefix is an explicit opt-in
                    // Claude Code subagents inherit the parent's session_id, so we can't distinguish by ID alone.
                    // The main agent is instructed to use a subagent; the prefix is the trust signal.
                    if rule.subagent_bypass && command.contains("WATCHDOG_BYPASS=1") {
                        info!("Subagent bypass accepted for forbidden command pattern '{}' (session {})", pattern, caller_session_id);
                        return None;
                    }

                    let mut reason = rule.message.clone().unwrap_or_else(|| {
                        format!("Command matches forbidden pattern '{}'", pattern)
                    });

                    if rule.subagent_bypass {
                        reason.push_str(" To bypass, use a subagent and prefix the command with `WATCHDOG_BYPASS=1`.");
                    }

                    self.record(AuditTrailEntry {
                        timestamp: Utc::now(),
                        finding: "violation".to_string(),
                        action: if enforcement { "denied" } else { "observed" }.to_string(),
                        source: "deterministic".to_string(),
                        rule_type: "forbidden_command".to_string(),
                        file_path: String::new(),
                        tool_name: tool_name.to_string(),
                        reason: reason.clone(),
                        details: serde_json::json!({
                            "pattern": pattern,
                            "command": command,
                        }),
                        rule_quote: rule.message.clone().unwrap_or_else(|| format!("forbidden_command: {}", pattern)),
                        enforcement,
                        issue_id: None,
                        event_type: None,
                        agent_session_id: Some(caller_session_id.to_string()),
                    });

                    return Some(reason);
                }
            }
        }

        None
    }

    /// Dismiss audit trail entries by timestamp, removing from memory and rewriting disk.
    /// Returns the number of entries removed.
    pub fn dismiss_entries(&mut self, timestamps: &[String]) -> usize {
        let before = self.trail.len();
        // Normalize timestamps: accept both Z and +00:00 suffixes
        let normalized: Vec<String> = timestamps.iter().map(|t| {
            t.replace("Z", "+00:00").replace("+00:00+00:00", "+00:00")
        }).collect();
        self.trail.retain(|entry| {
            let ts_str = entry.timestamp.to_rfc3339();
            let ts_z = ts_str.replace("+00:00", "Z");
            !timestamps.iter().any(|t| t == &ts_str || t == &ts_z) &&
            !normalized.iter().any(|t| t == &ts_str || t == &ts_z)
        });
        let removed = before - self.trail.len();
        if removed > 0 {
            self.rewrite_trail_file();
        }
        removed
    }

    /// Rewrite the entire audit trail JSONL file from the in-memory entries.
    fn rewrite_trail_file(&self) {
        if let Some(ref path) = self.trail_path {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            use std::io::Write;
            if let Ok(mut file) = std::fs::File::create(path) {
                for entry in &self.trail {
                    if let Ok(json) = serde_json::to_string(entry) {
                        let _ = writeln!(file, "{}", json);
                    }
                }
            }
        }
    }

    /// Get the audit trail
    pub fn get_trail(&self) -> &[AuditTrailEntry] {
        &self.trail
    }

    /// Get trail entries as JSON
    pub fn get_trail_json(&self) -> serde_json::Value {
        serde_json::to_value(&self.trail).unwrap_or(serde_json::json!([]))
    }

    /// Add an external entry (from LLM auditor) to the trail
    pub fn record_external(&mut self, entry: AuditTrailEntry) {
        self.persist_entry(&entry);
        self.trail.push(entry);
    }

    /// Add an entry to the trail and persist it
    fn record(&mut self, entry: AuditTrailEntry) {
        self.persist_entry(&entry);
        self.trail.push(entry);
    }

    /// Persist an entry to disk
    fn persist_entry(&self, entry: &AuditTrailEntry) {
        if let Some(ref path) = self.trail_path {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Ok(json) = serde_json::to_string(entry) {
                use std::io::Write;
                if let Ok(mut file) = std::fs::OpenOptions::new()
                    .create(true).append(true).open(path)
                {
                    let _ = writeln!(file, "{}", json);
                }
            }
        }
    }
}

/// Simple glob matching for forbidden paths
fn matches_glob(path: &str, pattern: &str) -> bool {
    if pattern.contains("**") {
        let prefix = pattern.split("**").next().unwrap_or("");
        path.contains(prefix.trim_end_matches('/'))
    } else if pattern.starts_with("*.") {
        let ext = &pattern[1..]; // ".env" etc
        path.ends_with(ext)
    } else {
        path.contains(pattern) || path.ends_with(pattern)
    }
}
