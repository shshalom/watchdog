use axum::{
    extract::State,
    extract::ws::{WebSocket, WebSocketUpgrade, Message},
    response::IntoResponse,
    Json,
};
use tracing::info;

use crate::models::{FileOperation, TrackedFile};
use crate::session::AppState;

/// GET /api/status
/// Returns rich session status for the `watchdog status` CLI command
pub(crate) async fn handle_get_status(State(state): State<AppState>) -> impl IntoResponse {
    let inner = state.inner.read().await;
    let session = &inner.session;
    let config = &inner.config;
    let elapsed = (chrono::Utc::now() - session.started_at).num_seconds();

    // Count pending audit files
    let pending_audit = inner.tracked_files.values()
        .filter(|f| f.audit_status == "pending")
        .count();

    // Count audit cycles from trail entries (current session only)
    let session_start = session.started_at;
    let audit_cycles = inner.rules_engine.get_trail()
        .iter()
        .filter(|e| e.timestamp >= session_start && e.source == "semantic" && e.tool_name == "LLM Auditor")
        .count();

    // Build drift events array
    let drift_events: Vec<serde_json::Value> = inner.active_drifts.values()
        .filter(|d| !matches!(d.state, crate::models::DriftState::Resolved))
        .map(|d| {
            serde_json::json!({
                "id": d.id,
                "file_path": d.file_path,
                "finding": d.finding,
                "rule_type": d.rule_type,
                "state": d.state,
                "reason": d.reason,
                "correction_attempts": d.correction_attempts,
                "detected_at": d.detected_at,
                "notified_at": d.notified_at,
            })
        })
        .collect();

    // Max escalation count across active drifts
    let escalation_count = inner.active_drifts.values()
        .map(|d| d.correction_attempts)
        .max()
        .unwrap_or(0);

    // Count spec files
    let spec_paths = if config.spec_paths.is_empty() {
        config.spec_path.iter().cloned().collect::<Vec<_>>()
    } else {
        config.spec_paths.clone()
    };

    Json(serde_json::json!({
        "session": {
            "id": session.id,
            "project_dir": session.project_dir,
            "status": session.status,
            "started_at": session.started_at,
            "elapsed_seconds": elapsed,
        },
        "enforcement": {
            "enabled": config.enforcement_enabled,
            "mode": config.audit_mode,
        },
        "files": {
            "tracked": inner.tracked_files.len(),
            "pending_audit": pending_audit,
        },
        "auditor": {
            "enabled": config.auditor_enabled,
            "model": config.auditor_model,
            "cycles_completed": audit_cycles,
            "next_audit_in_seconds": config.batch_interval_seconds,
        },
        "drift_events": drift_events,
        "escalation": {
            "count": escalation_count,
            "threshold": config.escalation_threshold,
        },
        "specs": {
            "count": spec_paths.len(),
            "locked": config.enforcement_enabled,
        },
    }))
}

/// POST /api/observe/register — register a session ID for observation
/// Also loads the session's transcript and queues files for audit.
pub(crate) async fn handle_register_session(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if let Some(session_id) = body.get("session_id").and_then(|v| v.as_str()) {
        let config = state.get_config().await;
        {
            let mut inner = state.inner.write().await;
            inner.observed_sessions.insert(session_id.to_string());
            info!("Registered session for observation: {}", session_id);
        }

        // Load transcript immediately so files are available and queued for audit
        load_transcript_files(&state, session_id, &config.project_dir).await;

        let inner = state.inner.read().await;
        Json(serde_json::json!({ "ok": true, "observed_sessions": inner.observed_sessions.len() }))
    } else {
        Json(serde_json::json!({ "error": "missing session_id" }))
    }
}

/// Load files from a session's transcript into tracked_files, filtering to existing files only.
pub(crate) async fn load_transcript_files(state: &AppState, session_id: &str, project_dir: &str) {
    let transcript_path = find_session_transcript(project_dir, session_id);
    let Some(path) = transcript_path else { return };

    let ops = crate::transcript::parse_transcript(&path);
    let mut inner = state.inner.write().await;
    // Auto-register session so handle_get_session recognizes it
    inner.observed_sessions.insert(session_id.to_string());
    let mut loaded = 0;

    for op in ops {
        let is_modifying = matches!(op.operation,
            FileOperation::Create | FileOperation::Modify | FileOperation::Delete);
        if !is_modifying { continue; }

        // Track deletes — don't remove, mark as deleted so graph can show them
        let operation = if matches!(op.operation, FileOperation::Delete) {
            // If the file was previously tracked, update it to Delete
            if let Some(existing) = inner.tracked_files.get_mut(&op.file_path) {
                existing.operation = FileOperation::Delete;
                existing.timestamp = op.timestamp;
            }
            continue;
        } else if !std::path::Path::new(&op.file_path).exists() {
            // File was modified in this session but no longer exists on disk — mark as deleted
            FileOperation::Delete
        } else {
            op.operation.clone()
        };

        let dir = std::path::Path::new(&op.file_path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        let prev_size = inner.tracked_files.get(&op.file_path).map(|t| t.change_size).unwrap_or(0);
        let op_size = op.write_content.as_ref().map(|c| c.lines().count())
            .or_else(|| op.edit_pair.as_ref().map(|(o, n)| o.lines().count() + n.lines().count()))
            .unwrap_or(0);

        // Refine: if file doesn't exist, keep as Delete from above;
        // otherwise upgrade Create→Modify if already tracked
        let operation = if operation == FileOperation::Delete {
            FileOperation::Delete
        } else if matches!(op.operation, FileOperation::Create)
            && inner.tracked_files.contains_key(&op.file_path) {
            FileOperation::Modify
        } else {
            operation
        };

        let is_create = matches!(operation, FileOperation::Create);
        let tracked = TrackedFile {
            path: op.file_path.clone(),
            operation,
            timestamp: op.timestamp,
            audit_status: "pending".to_string(),
            change_size: prev_size + op_size,
            directory: dir,
            imports: vec![],
            session_id: Some(session_id.to_string()),
        };
        inner.tracked_files.insert(op.file_path.clone(), tracked);

        // Store edit/create content for diff generation
        if let Some((old_str, new_str)) = op.edit_pair {
            inner.file_edits.entry(op.file_path.clone()).or_default().push((old_str, new_str));
        }
        if let Some(content) = op.write_content {
            if is_create {
                inner.file_creates.insert(op.file_path.clone(), content);
            }
        }

        loaded += 1;
    }

    if loaded > 0 {
        info!("Loaded {} files from transcript for session {}", loaded, session_id);
    }
}

/// POST /api/observe/unregister — unregister a session ID
pub(crate) async fn handle_unregister_session(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if let Some(session_id) = body.get("session_id").and_then(|v| v.as_str()) {
        let mut inner = state.inner.write().await;
        inner.observed_sessions.remove(session_id);
        info!("Unregistered session: {}", session_id);
        Json(serde_json::json!({ "ok": true, "observed_sessions": inner.observed_sessions.len() }))
    } else {
        Json(serde_json::json!({ "error": "missing session_id" }))
    }
}

/// Find a specific session's transcript file by session ID
pub(crate) fn find_session_transcript(project_dir: &str, session_id: &str) -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let project_hash = project_dir.replace('/', "-");
    let transcript = std::path::PathBuf::from(&home)
        .join(".claude").join("projects").join(&project_hash)
        .join(format!("{}.jsonl", session_id));
    if transcript.exists() { Some(transcript) } else { None }
}

pub(crate) async fn handle_ws_upgrade(
    State(state): State<AppState>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws_connection(socket, state))
}

async fn handle_ws_connection(mut socket: WebSocket, state: AppState) {
    info!("WebSocket client connected");
    let mut rx = state.event_tx.subscribe();

    loop {
        tokio::select! {
            result = rx.recv() => {
                match result {
                    Ok(event_json) => {
                        if socket.send(Message::Text(event_json.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("WebSocket client lagged, skipped {} events", n);
                    }
                    Err(_) => break,
                }
            }
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }

    info!("WebSocket client disconnected");
}
