use axum::{
    extract::{Path as AxumPath, State},
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

use crate::rules::AuditTrailEntry;
use crate::session::AppState;

/// GET /api/sessions/:id/audit-trail
/// Returns current session entries + entries linked to unresolved issues.
pub(crate) async fn handle_get_audit_trail(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    let inner = state.inner.read().await;

    let trail = inner.rules_engine.get_trail();
    // Build set of open issue IDs — for cross-session carryover
    let resolved: HashSet<&str> = trail.iter()
        .filter(|e| e.event_type.as_deref() == Some("issue_resolved"))
        .filter_map(|e| e.issue_id.as_deref()).collect();
    let open_issues: HashSet<&str> = trail.iter()
        .filter_map(|e| e.issue_id.as_deref())
        .filter(|iid| !resolved.contains(iid)).collect();
    // Collect all issue IDs that belong to this session (open or resolved)
    let session_issues: HashSet<&str> = trail.iter()
        .filter(|e| e.agent_session_id.as_deref() == Some(&*id))
        .filter_map(|e| e.issue_id.as_deref()).collect();

    let mut seen_keys: HashSet<String> = HashSet::new();
    let filtered: Vec<&AuditTrailEntry> = trail.iter()
        .filter(|e| {
            let path = e.file_path.as_str();
            // Skip bogus paths, but allow concerns and violations with empty paths
            if path == "/dev/null" || path == "&1" { return false; }
            if path.is_empty() && e.finding != "concern" && e.finding != "violation" { return false; }
            // Show entries for this session, linked to this session's issues, or open issues from other sessions
            e.agent_session_id.as_deref() == Some(&*id)
                || e.issue_id.as_deref().map_or(false, |iid| session_issues.contains(iid) || open_issues.contains(iid))
        })
        .filter(|e| {
            // Deduplicate by file_path + tool_name + finding (collapse repeated audits with varying reason text)
            let key = format!("{}-{}-{}", e.file_path, e.tool_name, e.finding);
            seen_keys.insert(key)
        })
        .collect();
    Json(serde_json::json!({
        "entries": filtered
    }))
}

/// POST /api/audit-trail/dismiss
/// Removes audit trail entries by timestamp.
pub(crate) async fn handle_dismiss_audit_entries(
    State(state): State<AppState>,
    Json(payload): Json<DismissAuditRequest>,
) -> impl IntoResponse {
    let mut inner = state.inner.write().await;
    let removed = inner.rules_engine.dismiss_entries(&payload.timestamps);
    let remaining = inner.rules_engine.get_trail().len();
    Json(serde_json::json!({
        "removed": removed,
        "remaining": remaining
    }))
}

#[derive(Debug, Deserialize)]
pub(crate) struct DismissAuditRequest {
    timestamps: Vec<String>,
}

/// GET /api/sessions/:id/issues
/// Assembles issue threads from audit trail entries grouped by issue_id
pub(crate) async fn handle_get_issues(
    State(state): State<AppState>,
    AxumPath(_id): AxumPath<String>,
) -> impl IntoResponse {
    let inner = state.inner.read().await;
    let trail = inner.rules_engine.get_trail();

    // Group entries by issue_id
    let mut threads: HashMap<String, Vec<&crate::rules::AuditTrailEntry>> = HashMap::new();
    for entry in trail {
        if let Some(ref issue_id) = entry.issue_id {
            threads.entry(issue_id.clone()).or_default().push(entry);
        }
    }

    // Build issue objects
    let mut issues: Vec<serde_json::Value> = Vec::new();
    for (issue_id, entries) in &threads {
        // Sort entries by timestamp
        let mut sorted = entries.clone();
        sorted.sort_by_key(|e| e.timestamp);

        let first = sorted.first().unwrap();
        let last = sorted.last().unwrap();
        let _ = last; // suppress unused warning

        // Determine status: resolved if any entry has event_type "issue_resolved"
        let is_resolved = sorted.iter().any(|e| {
            e.event_type.as_deref() == Some("issue_resolved")
        });

        let status = if is_resolved { "resolved" } else { "open" };

        // Find resolved_at timestamp
        let resolved_at = sorted.iter()
            .find(|e| e.event_type.as_deref() == Some("issue_resolved"))
            .map(|e| e.timestamp);

        // Count correction attempts (agent_responded events)
        let correction_attempts = sorted.iter()
            .filter(|e| e.event_type.as_deref() == Some("agent_responded"))
            .count();

        // Time to resolve
        let time_to_resolve_seconds = resolved_at.map(|r| {
            (r - first.timestamp).num_seconds()
        });

        // Build timeline
        let timeline: Vec<serde_json::Value> = sorted.iter().map(|e| {
            let mut entry_json = serde_json::json!({
                "timestamp": e.timestamp,
                "event_type": e.event_type,
                "details": e.details,
            });
            // Add contextual fields based on event type
            match e.event_type.as_deref() {
                Some("change_requested") => {
                    // Don't include raw "denied" action — it reads like the change was denied
                    entry_json["action"] = serde_json::json!("Agent blocked");
                }
                Some("agent_responded") => {
                    entry_json["tool"] = serde_json::json!(e.tool_name);
                    if let Some(cmd) = e.details.get("command").and_then(|v| v.as_str()) {
                        if !cmd.is_empty() {
                            entry_json["command"] = serde_json::json!(cmd);
                        }
                    }
                }
                _ => {}
            }
            entry_json
        }).collect();

        issues.push(serde_json::json!({
            "issue_id": issue_id,
            "file_path": first.file_path,
            "finding": first.finding,
            "status": status,
            "detected_at": first.timestamp,
            "resolved_at": resolved_at,
            "correction_attempts": correction_attempts,
            "time_to_resolve_seconds": time_to_resolve_seconds,
            "timeline": timeline,
        }));
    }

    // Sort issues by detected_at (most recent first)
    issues.sort_by(|a, b| {
        let a_ts = a.get("detected_at").and_then(|v| v.as_str()).unwrap_or("");
        let b_ts = b.get("detected_at").and_then(|v| v.as_str()).unwrap_or("");
        b_ts.cmp(a_ts)
    });

    Json(serde_json::json!({ "issues": issues }))
}
