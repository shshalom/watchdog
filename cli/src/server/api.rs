use axum::{
    extract::{Path as AxumPath, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use tracing::info;

use crate::models::*;
use crate::session::AppState;

/// GET /api/config
pub(crate) async fn handle_get_config(State(state): State<AppState>) -> impl IntoResponse {
    let inner = state.inner.read().await;
    let config = &inner.config;
    let has_api_key = config.anthropic_api_key.is_some();

    // Extract context_threshold warn/block from rules
    let (warn_pct, block_pct) = inner.rules_engine.rules().iter()
        .find(|r| r.rule_type == "context_threshold")
        .map(|r| (r.warn_percent.unwrap_or(30), r.block_percent.unwrap_or(70)))
        .unwrap_or((30, 70));

    Json(serde_json::json!({
        "api_port": config.port,
        "batch_interval_seconds": config.batch_interval_seconds,
        "escalation_threshold": config.escalation_threshold,
        "auditor_model": config.auditor_model,
        "auditor_enabled": config.auditor_enabled,
        "enforcement_enabled": config.enforcement_enabled,
        "audit_mode": config.audit_mode,
        "has_api_key": has_api_key,
        "context_warn_percent": warn_pct,
        "context_block_percent": block_pct,
        "config_sources": {
            "global": "~/.config/watchdog/config.yml",
            "project": ".watchdog/config.yml"
        }
    }))
}

/// POST /api/config/update
pub(crate) async fn handle_update_config(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let mut config = state.inner.write().await;

    if let Some(key) = body.get("anthropic_api_key").and_then(|v| v.as_str()) {
        config.config.anthropic_api_key = Some(key.to_string());
        let _ = crate::config::save_to_config_file("anthropic_api_key", key);
    }
    if let Some(model) = body.get("auditor_model").and_then(|v| v.as_str()) {
        config.config.auditor_model = model.to_string();
        let _ = crate::config::save_to_config_file("auditor_model", model);
    }
    if let Some(enabled) = body.get("auditor_enabled").and_then(|v| v.as_bool()) {
        config.config.auditor_enabled = enabled;
        let _ = crate::config::save_to_config_file("auditor_enabled", if enabled { "true" } else { "false" });
    }
    if let Some(interval) = body.get("batch_interval_seconds").and_then(|v| v.as_u64()) {
        config.config.batch_interval_seconds = interval;
        let _ = crate::config::save_to_config_file("batch_interval_seconds", &interval.to_string());
    }
    if let Some(threshold) = body.get("escalation_threshold").and_then(|v| v.as_u64()) {
        config.config.escalation_threshold = threshold as usize;
        let _ = crate::config::save_to_config_file("escalation_threshold", &threshold.to_string());
    }
    if let Some(enforcement) = body.get("enforcement_enabled").and_then(|v| v.as_bool()) {
        config.config.enforcement_enabled = enforcement;
        let _ = crate::config::save_to_config_file("enforcement_enabled", if enforcement { "true" } else { "false" });
    }
    if let Some(mode) = body.get("audit_mode").and_then(|v| v.as_str()) {
        config.config.audit_mode = mode.to_string();
        let _ = crate::config::save_to_config_file("audit_mode", mode);
    }

    Json(serde_json::json!({"status": "ok"}))
}

/// GET /api/sessions
pub(crate) async fn handle_get_sessions(State(state): State<AppState>) -> impl IntoResponse {
    let inner = state.inner.read().await;
    let session = &inner.session;
    let elapsed = (chrono::Utc::now() - session.started_at).num_seconds();

    let name = session.spec_path.as_deref()
        .and_then(|p| std::path::Path::new(p).file_stem())
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| session.id.chars().take(8).collect());

    // Count audit cycles from trail entries
    let audit_cycles = inner.rules_engine.get_trail()
        .iter()
        .filter(|e| e.source == "semantic" && e.tool_name == "LLM Auditor")
        .count();

    // Count active (non-resolved) drift events
    let active_drift_events = inner.active_drifts.values()
        .filter(|d| !matches!(d.state, crate::models::DriftState::Resolved))
        .count();

    // Max escalation count across active drifts
    let escalation_count = inner.active_drifts.values()
        .map(|d| d.correction_attempts)
        .max()
        .unwrap_or(0);

    let escalation_threshold = inner.config.escalation_threshold;

    // Derive status from current state to avoid stale cached status
    let status = crate::auditor::derive_session_status(&inner.active_drifts, escalation_threshold);

    let summary = SessionSummary {
        id: session.id.clone(),
        name,
        spec_path: session.spec_path.clone(),
        status,
        started_at: session.started_at,
        elapsed_seconds: elapsed,
        files_touched: session.files_touched,
        audit_cycles,
        active_drift_events,
        escalation_count,
        escalation_threshold,
    };

    Json(SessionsResponse {
        sessions: vec![summary],
    })
}

/// GET /api/sessions/:id
pub(crate) async fn handle_get_session(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    // Refresh context percent before reading (reads .agent.json)
    { state.inner.write().await.refresh_context_percent(); }
    let inner = state.inner.read().await;
    let session = &inner.session;
    let is_known = session.id == id
        || session.agent_session_id.as_deref() == Some(&id)
        || inner.observed_sessions.contains(&id);
    if !is_known {
        return Err(StatusCode::NOT_FOUND);
    }

    let elapsed = (chrono::Utc::now() - session.started_at).num_seconds();

    let name = session.spec_path.as_deref()
        .and_then(|p| std::path::Path::new(p).file_stem())
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| session.id.chars().take(8).collect());

    // Count audit cycles from trail entries
    let audit_cycles_total = inner.rules_engine.get_trail()
        .iter()
        .filter(|e| e.source == "semantic" && e.tool_name == "LLM Auditor")
        .count();

    // Count drift events from active_drifts (authoritative state)
    let drift_events_unresolved = inner.active_drifts.values()
        .filter(|d| !matches!(d.state, DriftState::Resolved))
        .count();

    // Count total and resolved from trail
    let mut issue_ids_resolved: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut issue_ids_total: std::collections::HashSet<String> = std::collections::HashSet::new();
    for entry in inner.rules_engine.get_trail() {
        if let Some(ref id) = entry.issue_id {
            issue_ids_total.insert(id.clone());
            if entry.event_type.as_deref() == Some("issue_resolved") {
                issue_ids_resolved.insert(id.clone());
            }
        }
    }
    let drift_events_total = issue_ids_total.len();
    let drift_events_resolved = issue_ids_resolved.len();

    // Resolve effective per-session enforcement and mode
    let enforcement_enabled = inner.enforcement_for_session(&id);
    let audit_mode = inner.audit_mode_for_session(&id);

    Ok(Json(SessionDetailResponse {
        id: session.id.clone(),
        name,
        spec_path: session.spec_path.clone(),
        status: session.status.clone(),
        started_at: session.started_at,
        elapsed_seconds: elapsed,
        agent_session_id: session.agent_session_id.clone(),
        files_touched: session.files_touched,
        files_created: session.files_created,
        files_modified: session.files_modified,
        files_deleted: session.files_deleted,
        audit_cycles_total,
        drift_events_total,
        drift_events_resolved,
        drift_events_unresolved,
        enforcement_enabled,
        audit_mode,
        context_percent: inner.context_percent,
    }))
}

/// GET /api/sessions/:id/files
pub(crate) async fn handle_get_session_files(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Json<FilesResponse> {
    // Check if we already have files for this session
    let all_files = state.get_tracked_files().await;
    let session_files: Vec<TrackedFile> = all_files.into_iter()
        .filter(|f| f.session_id.as_deref() == Some(&id))
        .collect();

    if !session_files.is_empty() {
        return Json(FilesResponse { files: session_files });
    }

    // No files yet — try loading from this session's transcript
    let config = state.get_config().await;
    super::status::load_transcript_files(&state, &id, &config.project_dir).await;

    let inner = state.inner.read().await;
    let files: Vec<TrackedFile> = inner.tracked_files.values()
        .filter(|f| f.session_id.as_deref() == Some(&*id))
        .cloned()
        .collect();
    Json(FilesResponse { files })
}

/// GET /api/sessions/:id/spec
pub(crate) async fn handle_get_spec(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    let session = state.get_session_info().await;
    {
        let inner = state.inner.read().await;
        let is_known = session.id == id
            || session.agent_session_id.as_deref() == Some(&id)
            || inner.observed_sessions.contains(&id);
        if !is_known {
            return Err(StatusCode::NOT_FOUND);
        }
    }

    let config = state.get_config().await;
    let spec_paths = if config.spec_paths.is_empty() {
        config.spec_path.iter().cloned().collect::<Vec<_>>()
    } else {
        config.spec_paths.clone()
    };

    if spec_paths.is_empty() {
        return Ok(Json(serde_json::json!({ "specs": [] })));
    }

    // Read all spec files, resolving paths robustly
    let project_dir = &session.project_dir;
    let mut specs = Vec::new();
    for spec_path in &spec_paths {
        let candidates = [
            // 1. Relative to project dir (e.g. "SPEC.md")
            std::path::Path::new(project_dir).join(spec_path),
            // 2. Treat as absolute with missing leading / (e.g. "Users/shwaits/.../SPEC.md")
            std::path::PathBuf::from(format!("/{}", spec_path)),
            // 3. Already absolute
            std::path::PathBuf::from(spec_path),
        ];
        for candidate in &candidates {
            if let Ok(content) = std::fs::read_to_string(candidate) {
                specs.push(serde_json::json!({
                    "path": spec_path,
                    "content": content,
                }));
                break;
            }
        }
    }

    // Return first spec as primary for backward compat, plus all specs
    let primary_path = spec_paths.first().cloned().unwrap_or_default();
    let primary_content = specs.first()
        .and_then(|s| s.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");

    Ok(Json(serde_json::json!({
        "path": primary_path,
        "locked_at": session.started_at,
        "content": primary_content,
        "specs": specs,
    })))
}

/// GET /api/sessions/:id/diff/*path
pub(crate) async fn handle_get_file_diff(
    State(state): State<AppState>,
    AxumPath((id, file_path)): AxumPath<(String, String)>,
) -> impl IntoResponse {
    let session = state.get_session_info().await;
    {
        let inner = state.inner.read().await;
        let is_known = session.id == id
            || session.agent_session_id.as_deref() == Some(&id)
            || inner.observed_sessions.contains(&id);
        if !is_known {
            return Err(StatusCode::NOT_FOUND);
        }
    }

    let files = state.get_tracked_files().await;
    let tracked = match files.iter().find(|f| f.path.ends_with(&file_path) || f.path == file_path) {
        Some(t) => t.clone(),
        None => return Err(StatusCode::NOT_FOUND),
    };

    let ext = std::path::Path::new(&tracked.path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("txt")
        .to_string();

    let short_path = std::path::Path::new(&tracked.path)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or(file_path.clone());

    let (diff, lines_added, lines_removed) = match tracked.operation {
        FileOperation::Create => {
            // For new files, show content from Write tool_input
            let content = state.get_file_create_content(&tracked.path).await
                .or_else(|| std::fs::read_to_string(&tracked.path).ok())
                .unwrap_or_default();
            let lines: Vec<&str> = content.lines().collect();
            let count = lines.len();
            let mut diff = format!("--- /dev/null\n+++ b/{}\n@@ -0,0 +1,{} @@\n", short_path, count);
            for line in &lines {
                diff.push_str(&format!("+{}\n", line));
            }
            (diff, count, 0)
        }
        FileOperation::Modify => {
            // For edits, use stored old_string/new_string pairs
            let edits = state.get_file_edits(&tracked.path).await;
            if edits.is_empty() {
                // Fallback: show current content as context
                let content = std::fs::read_to_string(&tracked.path).unwrap_or_default();
                let lines: Vec<&str> = content.lines().collect();
                let mut diff = format!("--- a/{}\n+++ b/{}\n", short_path, short_path);
                for line in &lines {
                    diff.push_str(&format!(" {}\n", line));
                }
                (diff, 0, 0)
            } else {
                let mut diff = format!("--- a/{}\n+++ b/{}\n", short_path, short_path);
                let mut total_added = 0;
                let mut total_removed = 0;
                for (old_str, new_str) in &edits {
                    let old_lines: Vec<&str> = old_str.lines().collect();
                    let new_lines: Vec<&str> = new_str.lines().collect();
                    diff.push_str(&format!("@@ -{},{} +{},{} @@\n",
                        1, old_lines.len(), 1, new_lines.len()));
                    for line in &old_lines {
                        diff.push_str(&format!("-{}\n", line));
                    }
                    for line in &new_lines {
                        diff.push_str(&format!("+{}\n", line));
                    }
                    total_removed += old_lines.len();
                    total_added += new_lines.len();
                }
                (diff, total_added, total_removed)
            }
        }
        FileOperation::Delete => {
            // For deleted files, show as all removed (file may not exist on disk anymore)
            let mut diff = format!("--- a/{}\n+++ /dev/null\n@@ -1,1 +0,0 @@\n", short_path);
            diff.push_str(&format!("-[file deleted]\n"));
            (diff, 0, 1)
        }
        FileOperation::Bash => {
            // For bash operations, show the command
            let mut diff = String::new();
            diff.push_str(&format!("@@ bash command @@\n"));
            diff.push_str(&format!("-[previous state]\n"));
            diff.push_str(&format!("+[modified by bash command]\n"));
            (diff, 1, 1)
        }
        _ => {
            (String::new(), 0, 0)
        }
    };

    Ok(Json(serde_json::json!({
        "path": file_path,
        "operation": tracked.operation,
        "diff": diff,
        "language": ext,
        "lines_added": lines_added,
        "lines_removed": lines_removed
    })))
}

/// POST /api/sessions/:id/config
/// Update per-session configuration (enforcement_enabled, audit_mode).
/// These override the global config for this specific session.
pub(crate) async fn handle_update_session_config(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let mut inner = state.inner.write().await;

    // Get or create per-session config
    let sc = inner.session_configs.entry(id.clone())
        .or_insert_with(|| crate::session::SessionConfig {
            enforcement_enabled: None,
            audit_mode: None,
        });

    if let Some(enforcement) = body.get("enforcement_enabled").and_then(|v| v.as_bool()) {
        sc.enforcement_enabled = Some(enforcement);
        info!("Session {} enforcement_enabled set to {}", id, enforcement);
    }
    if let Some(mode) = body.get("audit_mode").and_then(|v| v.as_str()) {
        sc.audit_mode = Some(mode.to_string());
        info!("Session {} audit_mode set to {}", id, mode);
    }

    Json(serde_json::json!({"status": "ok"}))
}

/// Expand any directory paths into their contained spec files (.md, .yaml, .yml, .txt).
/// File paths pass through unchanged.
fn expand_spec_paths(paths: Vec<String>) -> Vec<String> {
    let mut result = Vec::new();
    for path in paths {
        let p = std::path::Path::new(&path);
        if p.is_dir() {
            let mut dir_files: Vec<String> = std::fs::read_dir(p)
                .into_iter()
                .flatten()
                .flatten()
                .filter_map(|entry| {
                    let ep = entry.path();
                    if !ep.is_file() { return None; }
                    let ext = ep.extension()?.to_str()?.to_lowercase();
                    if matches!(ext.as_str(), "md" | "yaml" | "yml" | "txt") {
                        ep.to_str().map(|s| s.to_string())
                    } else {
                        None
                    }
                })
                .collect();
            dir_files.sort();
            result.extend(dir_files);
        } else {
            result.push(path);
        }
    }
    result
}

/// POST /api/reload-specs
/// Reload spec files and update the auditor's spec list
pub(crate) async fn handle_reload_specs(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let mut inner = state.inner.write().await;

    // Accept new spec paths from the request body; expand any directories.
    if let Some(specs) = body.get("spec_paths").and_then(|v| v.as_array()) {
        let raw_paths: Vec<String> = specs.iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect();
        let new_paths = expand_spec_paths(raw_paths);

        inner.config.spec_paths = new_paths.clone();
        inner.config.spec_path = new_paths.first().cloned();

        // Persist so specs survive server restart
        let _ = crate::config::save_project_spec_paths(&inner.config.project_dir, &new_paths);

        info!("Reloaded {} spec files", new_paths.len());
        for path in &new_paths {
            info!("  Spec: {}", path);
        }

        // Reset all file audit statuses to pending so they get re-evaluated
        for tracked in inner.tracked_files.values_mut() {
            tracked.audit_status = "pending".to_string();
        }

        // Broadcast spec reload event
        let event = serde_json::json!({
            "type": "specs_reloaded",
            "spec_paths": new_paths,
        });
        let _ = state.event_tx.send(event.to_string());
    }

    Json(serde_json::json!({"status": "ok"}))
}

/// GET /api/handoff
pub(crate) async fn handle_get_handoff(
    State(state): State<AppState>,
) -> impl IntoResponse {
    let inner = state.inner.read().await;
    match &inner.handoff {
        Some(h) => Json(serde_json::to_value(h).unwrap_or(serde_json::Value::Null)).into_response(),
        None => Json(serde_json::Value::Null).into_response(),
    }
}

/// POST /api/handoff/mark-used
pub(crate) async fn handle_mark_handoff_used(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let session_id = body.get("session_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let event_data = {
        let mut inner = state.inner.write().await;
        if let Some(ref mut h) = inner.handoff {
            if h.used_by_session_id.is_none() {
                h.used_by_session_id = Some(session_id.clone());
                h.used_at = Some(chrono::Utc::now());
                Some((h.path.clone(), session_id.clone()))
            } else { None }
        } else { None }
    };

    if let Some((h_path, used_by)) = event_data {
        let _ = state.event_tx.send(serde_json::json!({
            "type": "handoff_used",
            "path": h_path,
            "used_by_session_id": used_by,
        }).to_string());
    }

    Json(serde_json::json!({"status": "ok"}))
}
