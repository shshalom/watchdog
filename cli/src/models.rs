use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Hook payloads from Claude Code ──

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HookPayload {
    pub session_id: String,
    #[serde(default)]
    pub hook_event_name: String,
    pub tool_name: String,
    #[serde(default)]
    pub tool_input: serde_json::Value,
    #[serde(default)]
    pub tool_response: Option<serde_json::Value>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub transcript_path: Option<String>,
}

// ── PreToolUse response ──

#[derive(Debug, Clone, Serialize)]
pub struct PreToolUseResponse {
    #[serde(rename = "hookSpecificOutput")]
    pub hook_specific_output: PreToolUseOutput,
}

#[derive(Debug, Clone, Serialize)]
pub struct PreToolUseOutput {
    #[serde(rename = "hookEventName")]
    pub hook_event_name: String,
    #[serde(rename = "permissionDecision")]
    pub permission_decision: String,
    #[serde(rename = "permissionDecisionReason")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_decision_reason: Option<String>,
    #[serde(rename = "additionalContext")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub additional_context: Option<String>,
}

impl PreToolUseResponse {
    pub fn allow() -> Self {
        Self {
            hook_specific_output: PreToolUseOutput {
                hook_event_name: "PreToolUse".to_string(),
                permission_decision: "allow".to_string(),
                permission_decision_reason: None,
                additional_context: None,
            },
        }
    }

    pub fn deny(reason: &str, context: &str) -> Self {
        Self {
            hook_specific_output: PreToolUseOutput {
                hook_event_name: "PreToolUse".to_string(),
                permission_decision: "deny".to_string(),
                permission_decision_reason: Some(reason.to_string()),
                additional_context: Some(context.to_string()),
            },
        }
    }

    pub fn allow_with_context(context: &str) -> Self {
        Self {
            hook_specific_output: PreToolUseOutput {
                hook_event_name: "PreToolUse".to_string(),
                permission_decision: "allow".to_string(),
                permission_decision_reason: None,
                additional_context: Some(context.to_string()),
            },
        }
    }
}

// ── Change log entry ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeLogEntry {
    pub timestamp: DateTime<Utc>,
    pub session_id: String,
    pub tool_name: String,
    pub operation: FileOperation,
    pub file_path: Option<String>,
    pub tool_input: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_response: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FileOperation {
    Create,
    Modify,
    Delete,
    Read,
    Bash,
    Unknown,
}

// ── Drift tracking ──

/// Per-drift lifecycle state machine.
/// detected → notified → correction_pending → resolved
///                                          → unresolved → detected (restart)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DriftState {
    /// Auditor found drift on this file
    Detected,
    /// Agent has been told about this drift (deny or warn delivered)
    Notified,
    /// Agent is working after notification; awaiting next audit cycle
    CorrectionPending,
    /// Audit cycle confirmed the file is now aligned
    Resolved,
    /// Audit cycle found drift persists after correction attempt
    Unresolved,
}

impl std::fmt::Display for DriftState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DriftState::Detected => write!(f, "detected"),
            DriftState::Notified => write!(f, "notified"),
            DriftState::CorrectionPending => write!(f, "correction_pending"),
            DriftState::Resolved => write!(f, "resolved"),
            DriftState::Unresolved => write!(f, "unresolved"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriftEvent {
    pub id: String,
    pub file_path: String,
    pub finding: String,          // "drift", "violation"
    pub rule_type: String,        // e.g. "scope_drift", "scope_expansion"
    pub reason: String,
    pub correction: String,
    pub evidence: Vec<String>,
    pub severity: String,
    pub source: String,           // "deterministic", "semantic"
    pub state: DriftState,
    pub detected_at: chrono::DateTime<chrono::Utc>,
    pub notified_at: Option<chrono::DateTime<chrono::Utc>>,
    pub resolved_at: Option<chrono::DateTime<chrono::Utc>>,
    pub correction_attempts: usize,
}

// ── Session state ──

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Waiting,
    Observing,
    DriftDetected,
    Correcting,
    Halted,
    Completed,
    Stopped,
}

impl std::fmt::Display for SessionStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionStatus::Waiting => write!(f, "waiting"),
            SessionStatus::Observing => write!(f, "observing"),
            SessionStatus::DriftDetected => write!(f, "drift_detected"),
            SessionStatus::Correcting => write!(f, "correcting"),
            SessionStatus::Halted => write!(f, "halted"),
            SessionStatus::Completed => write!(f, "completed"),
            SessionStatus::Stopped => write!(f, "stopped"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub agent_session_id: Option<String>,
    pub spec_path: Option<String>,
    pub status: SessionStatus,
    pub started_at: DateTime<Utc>,
    pub port: u16,
    pub project_dir: String,
    pub files_touched: usize,
    pub files_created: usize,
    pub files_modified: usize,
    pub files_deleted: usize,
}

// ── File tracking ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackedFile {
    pub path: String,
    pub operation: FileOperation,
    pub timestamp: DateTime<Utc>,
    pub audit_status: String,
    #[serde(default)]
    pub change_size: usize,
    pub directory: String,
    #[serde(default)]
    pub imports: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

// ── API responses ──

#[derive(Debug, Serialize)]
pub struct SessionsResponse {
    pub sessions: Vec<SessionSummary>,
}

#[derive(Debug, Serialize)]
pub struct SessionSummary {
    pub id: String,
    pub name: String,
    pub spec_path: Option<String>,
    pub status: SessionStatus,
    pub started_at: DateTime<Utc>,
    pub elapsed_seconds: i64,
    pub files_touched: usize,
    pub audit_cycles: usize,
    pub active_drift_events: usize,
    pub escalation_count: usize,
    pub escalation_threshold: usize,
}

#[derive(Debug, Serialize)]
pub struct SessionDetailResponse {
    pub id: String,
    pub name: String,
    pub spec_path: Option<String>,
    pub status: SessionStatus,
    pub started_at: DateTime<Utc>,
    pub elapsed_seconds: i64,
    pub agent_session_id: Option<String>,
    pub files_touched: usize,
    pub files_created: usize,
    pub files_modified: usize,
    pub files_deleted: usize,
    pub audit_cycles_total: usize,
    pub drift_events_total: usize,
    pub drift_events_resolved: usize,
    pub drift_events_unresolved: usize,
    pub enforcement_enabled: bool,
    pub audit_mode: String,
    pub context_percent: u8,
}

/// Handoff lifecycle record — tracks when an agent writes a handoff doc and when
/// a new session consumes it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandoffRecord {
    pub id: String,
    pub session_id: String,
    pub path: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub is_outdated: bool,
    pub used_by_session_id: Option<String>,
    pub used_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct FilesResponse {
    pub files: Vec<TrackedFile>,
}

#[derive(Debug, Serialize)]
pub struct ConfigResponse {
    pub api_port: u16,
    pub batch_interval_seconds: u64,
    pub escalation_threshold: usize,
    pub config_sources: HashMap<String, String>,
}
