use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use tracing::info;

use crate::models::*;
use crate::rules::AuditTrailEntry;
use crate::session::AppState;

/// POST /hook/pre-tool-use
/// Receives PreToolUse events from Claude Code.
/// Broadcasts intent event for real-time UI + future audit pre-check.
pub(crate) async fn handle_pre_tool_use(
    State(state): State<AppState>,
    Json(payload): Json<HookPayload>,
) -> impl IntoResponse {
    tracing::debug!(
        tool = %payload.tool_name,
        session = %payload.session_id,
        "PreToolUse hook received"
    );

    // Discover main agent session ID on first hook (needed for subagent bypass)
    {
        let mut inner = state.inner.write().await;
        if !inner.session_discovered {
            inner.session.agent_session_id = Some(payload.session_id.clone());
            inner.session.status = crate::models::SessionStatus::Observing;
            inner.session_discovered = true;
            inner.transcript_path = payload.transcript_path.clone();
            info!("Session discovered via PreToolUse: agent_session_id={}", payload.session_id);
        }
    }

    // Handoff lifecycle: observe before any blocking checks so we always track state
    handle_handoff_pre(&state, &payload).await;

    // Extract file path and operation from the intended tool call
    let (file_path, operation) = crate::changelog::extract_file_info(
        &payload.tool_name, &payload.tool_input);

    // ── LockWatch enforcement — checked FIRST, before all other rules ──────
    // Lock: deny Write/Edit on locked files (even with --dangerously-skip-permissions)
    // Watch: allow but emit watch_triggered event for Read/Write/Edit on watched files
    if let Some(ref path) = file_path {
        let (is_locked, is_watched) = {
            let inner = state.inner.read().await;
            let lw = inner.lockwatch.lock().unwrap();
            (lw.is_locked(path), lw.is_watched(path))
        };

        let is_write = matches!(payload.tool_name.as_str(), "Write" | "Edit");

        // Fire watch_triggered for write intent BEFORE the lock check, so that
        // watched+locked files still notify the user of the attempt.
        // Reads are handled in post-tool-use (after the read completes).
        if is_watched && is_write {
            let _ = state.event_tx.send(serde_json::json!({
                "type": "watch_triggered",
                "timestamp": chrono::Utc::now(),
                "path": path,
                "operation": "write",
                "tool_name": payload.tool_name,
            }).to_string());
        }

        if is_locked && is_write {
            // Record in audit trail
            {
                let mut inner = state.inner.write().await;
                let enforcement = inner.enforcement_for_session(&payload.session_id);
                inner.rules_engine.record_external(crate::rules::AuditTrailEntry {
                    timestamp: chrono::Utc::now(),
                    finding: "violation".to_string(),
                    action: if enforcement { "denied" } else { "observed" }.to_string(),
                    source: "deterministic".to_string(),
                    rule_type: "file_locked".to_string(),
                    file_path: path.clone(),
                    tool_name: payload.tool_name.clone(),
                    reason: format!("🔒 File is locked: {}", path),
                    details: serde_json::json!({}),
                    rule_quote: "Locked via AgentWatchdog Files tab".to_string(),
                    enforcement,
                    issue_id: None,
                    event_type: None,
                    agent_session_id: Some(payload.session_id.clone()),
                });
            }

            let _ = state.event_tx.send(serde_json::json!({
                "type": "rule_violation",
                "timestamp": chrono::Utc::now(),
                "file_path": path,
                "reason": format!("🔒 File is locked: {}", path),
                "tool_name": payload.tool_name,
                "action": "denied",
            }).to_string());

            return Json(PreToolUseResponse::deny(
                &format!("Watchdog: file locked — {}", path),
                &format!("🔒 This file is locked by AgentWatchdog and cannot be modified. Unlock it in the Files tab to proceed."),
            ));
        }

    }

    // ── Bash lock enforcement ────────────────────────────────────────────────
    // Parse the shell command for write patterns (>, >>, tee, cp, mv, sed -i)
    // and deny if the destination matches a locked path.
    if payload.tool_name == "Bash" {
        let command = payload.tool_input
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let locked_path = {
            let inner = state.inner.read().await;
            let lw = inner.lockwatch.lock().unwrap();
            bash_locked_write(command, &lw)
        };

        if let Some(ref path) = locked_path {
            {
                let mut inner = state.inner.write().await;
                let enforcement = inner.enforcement_for_session(&payload.session_id);
                inner.rules_engine.record_external(crate::rules::AuditTrailEntry {
                    timestamp: chrono::Utc::now(),
                    finding: "violation".to_string(),
                    action: if enforcement { "denied" } else { "observed" }.to_string(),
                    source: "deterministic".to_string(),
                    rule_type: "file_locked".to_string(),
                    file_path: path.clone(),
                    tool_name: payload.tool_name.clone(),
                    reason: format!("🔒 File is locked: {}", path),
                    details: serde_json::json!({}),
                    rule_quote: "Locked via AgentWatchdog Files tab".to_string(),
                    enforcement,
                    issue_id: None,
                    event_type: None,
                    agent_session_id: Some(payload.session_id.clone()),
                });
            }

            let _ = state.event_tx.send(serde_json::json!({
                "type": "rule_violation",
                "timestamp": chrono::Utc::now(),
                "file_path": path,
                "reason": format!("🔒 File is locked: {}", path),
                "tool_name": "Bash",
                "action": "denied",
            }).to_string());

            return Json(PreToolUseResponse::deny(
                &format!("Watchdog: file locked — {}", path),
                "🔒 This file is locked by AgentWatchdog. The shell command would write to a locked path. Unlock it in the Files tab to proceed.",
            ));
        }
    }

    // Context threshold check — runs on ALL tools, before any other checks
    {
        let mut inner = state.inner.write().await;
        inner.refresh_context_percent();
        let context_percent = inner.context_percent;
        let enforcement = inner.enforcement_for_session(&payload.session_id);
        let handoff_written = inner.handoff_written;

        // Find context_threshold rules
        for rule in &inner.rules_engine.rules().to_vec() {
            if rule.rule_type != "context_threshold" {
                continue;
            }

            let block_pct = rule.block_percent.unwrap_or(70);
            let warn_pct = rule.warn_percent.unwrap_or(30);

            // Block check: context >= block_percent AND no handoff written
            if context_percent >= block_pct && !handoff_written {
                let message = rule.block_message.clone().unwrap_or_else(|| {
                    "Context window at {percent}%. You MUST create a handoff document before continuing.".to_string()
                }).replace("{percent}", &context_percent.to_string());

                inner.context_blocked = true;

                // Record in audit trail
                inner.rules_engine.record_external(AuditTrailEntry {
                    timestamp: chrono::Utc::now(),
                    finding: "violation".to_string(),
                    action: if enforcement { "denied" } else { "observed" }.to_string(),
                    source: "deterministic".to_string(),
                    rule_type: "context_threshold".to_string(),
                    file_path: file_path.as_deref().unwrap_or("").to_string(),
                    tool_name: payload.tool_name.clone(),
                    reason: message.clone(),
                    details: serde_json::json!({
                        "context_percent": context_percent,
                        "block_percent": block_pct,
                        "handoff_written": handoff_written,
                    }),
                    rule_quote: format!("context_threshold block at {}%", block_pct),
                    enforcement,
                    issue_id: None,
                    event_type: None,
                    agent_session_id: Some(payload.session_id.clone()),
                });

                // Broadcast violation event
                let violation_event = serde_json::json!({
                    "type": "rule_violation",
                    "timestamp": chrono::Utc::now(),
                    "file_path": file_path.as_deref().unwrap_or(""),
                    "reason": message.clone(),
                    "tool_name": payload.tool_name,
                    "action": if enforcement { "denied" } else { "observed" },
                });
                let _ = state.event_tx.send(violation_event.to_string());

                if enforcement {
                    // Allow Write operations to handoff files even when blocked
                    let is_handoff_write = if payload.tool_name == "Write" {
                        payload.tool_input.get("file_path")
                            .and_then(|v| v.as_str())
                            .map(|p| {
                                let name = std::path::Path::new(p)
                                    .file_name()
                                    .and_then(|f| f.to_str())
                                    .unwrap_or("")
                                    .to_lowercase();
                                name.contains("handoff")
                            })
                            .unwrap_or(false)
                    } else {
                        false
                    };

                    if !is_handoff_write {
                        return Json(PreToolUseResponse::deny(
                            &format!("Watchdog: context threshold — {}", message),
                            &message,
                        ));
                    }
                }
            }
            // Warn check: context >= warn_percent AND not already warned
            else if context_percent >= warn_pct && !inner.context_warned {
                let message = rule.warn_message.clone().unwrap_or_else(|| {
                    "Context window at {percent}%. Create a handoff document and start a new session.".to_string()
                }).replace("{percent}", &context_percent.to_string());

                inner.context_warned = true;

                // Record in audit trail
                inner.rules_engine.record_external(AuditTrailEntry {
                    timestamp: chrono::Utc::now(),
                    finding: "concern".to_string(),
                    action: "warned".to_string(),
                    source: "deterministic".to_string(),
                    rule_type: "context_threshold".to_string(),
                    file_path: file_path.as_deref().unwrap_or("").to_string(),
                    tool_name: payload.tool_name.clone(),
                    reason: message.clone(),
                    details: serde_json::json!({
                        "context_percent": context_percent,
                        "warn_percent": warn_pct,
                    }),
                    rule_quote: format!("context_threshold warn at {}%", warn_pct),
                    enforcement,
                    issue_id: None,
                    event_type: None,
                    agent_session_id: Some(payload.session_id.clone()),
                });

                return Json(PreToolUseResponse::allow_with_context(&message));
            }

            break; // Only process the first context_threshold rule
        }
    }

    // Broadcast intent event over WebSocket for immediate UI feedback
    if let Some(ref path) = file_path {
        let dir = std::path::Path::new(path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        let event = serde_json::json!({
            "type": "file_intent",
            "timestamp": chrono::Utc::now(),
            "path": path,
            "operation": operation,
            "tool_name": payload.tool_name,
            "directory": dir,
        });
        let _ = state.event_tx.send(event.to_string());

        // Check enforcement state (per-session)
        let enforcement = state.inner.read().await.enforcement_for_session(&payload.session_id);

        // Protect locked spec files — only when enforcement is ON and not in Learning mode
        if enforcement && matches!(operation, FileOperation::Create | FileOperation::Modify | FileOperation::Delete) {
            let inner = state.inner.read().await;
            let is_learning = inner.audit_mode_for_session(&payload.session_id) == "learning";
            // Check ALL spec files are protected
            let all_specs: Vec<String> = if inner.config.spec_paths.is_empty() {
                inner.config.spec_path.iter().cloned().collect()
            } else {
                inner.config.spec_paths.clone()
            };
            for spec_path in &all_specs {
                let full_spec = std::path::Path::new(&inner.config.project_dir).join(spec_path);
                let full_spec_str = full_spec.to_string_lossy().to_string();
                if path == &full_spec_str || path.ends_with(spec_path.as_str()) {
                    if is_learning {
                        // Learning mode: allow spec edits with observation
                        info!("Learning mode: allowing spec edit to '{}'", spec_path);
                        break;
                    }
                    let reason = format!("Spec file '{}' is locked — the watchdog is actively observing against it. Switch to Learning mode or stop the session to edit the spec.", spec_path);

                    let drift_event = serde_json::json!({
                        "type": "drift_detected",
                        "drift_event_id": format!("spec-lock-{}", chrono::Utc::now().timestamp()),
                        "file_path": path,
                        "severity": "hard_stop",
                        "reason": reason.clone(),
                    });
                    let _ = state.event_tx.send(drift_event.to_string());

                    return Json(PreToolUseResponse::deny(
                        &format!("Watchdog: {}", reason),
                        &reason,
                    ));
                }
            }
            // Also protect rules.yml (never unlocked, even in Learning mode)
            if path.ends_with("rules.yml") {
                let reason = "Rules file 'rules.yml' is locked during active observation.".to_string();
                return Json(PreToolUseResponse::deny(
                    &format!("Watchdog: {}", reason),
                    &reason,
                ));
            }
            drop(inner);
        }

        // Pre-check: will this write violate deterministic rules?
        if matches!(operation, FileOperation::Create | FileOperation::Modify) {
            let resulting_lines = match payload.tool_name.as_str() {
                "Write" => {
                    payload.tool_input.get("content")
                        .and_then(|v| v.as_str())
                        .map(|s| s.lines().count())
                        .unwrap_or(0)
                }
                "Edit" => {
                    let current = std::fs::read_to_string(path).unwrap_or_default();
                    let old_str = payload.tool_input.get("old_string")
                        .and_then(|v| v.as_str()).unwrap_or("");
                    let new_str = payload.tool_input.get("new_string")
                        .and_then(|v| v.as_str()).unwrap_or("");
                    current.replace(old_str, new_str).lines().count()
                }
                _ => 0,
            };

            let violation = {
                let mut inner = state.inner.write().await;
                inner.rules_engine.check_violation(
                    path, &payload.tool_name, resulting_lines, enforcement
                )
            }; // inner dropped here

            if let Some(reason) = violation {
                // Broadcast violation event
                let violation_event = serde_json::json!({
                    "type": "rule_violation",
                    "timestamp": chrono::Utc::now(),
                    "file_path": path,
                    "reason": reason.clone(),
                    "tool_name": payload.tool_name,
                    "action": if enforcement { "denied" } else { "observed" },
                });
                let _ = state.event_tx.send(violation_event.to_string());

                // Only deny if enforcement is on
                if !enforcement {
                    return Json(PreToolUseResponse::allow());
                }

                return Json(PreToolUseResponse::deny(
                    &format!("Watchdog: rule violation — {}", reason),
                    &format!("Deterministic rule violated. {}", reason),
                ));
            }
        }
    }

    // Pre-check: forbidden command rules for Bash
    if payload.tool_name == "Bash" {
        let enforcement = state.inner.read().await.enforcement_for_session(&payload.session_id);
        if let Some(command) = payload.tool_input.get("command").and_then(|v| v.as_str()) {
            let violation = {
                let mut inner = state.inner.write().await;
                let main_sid = inner.session.agent_session_id.clone();
                inner.rules_engine.check_command_violation(
                    command, &payload.tool_name, enforcement,
                    &payload.session_id, main_sid.as_deref(),
                )
            };

            if let Some(reason) = violation {
                let violation_event = serde_json::json!({
                    "type": "rule_violation",
                    "timestamp": chrono::Utc::now(),
                    "file_path": "",
                    "reason": reason.clone(),
                    "tool_name": payload.tool_name,
                    "action": if enforcement { "denied" } else { "observed" },
                });
                let _ = state.event_tx.send(violation_event.to_string());

                if !enforcement {
                    return Json(PreToolUseResponse::allow());
                }

                return Json(PreToolUseResponse::deny(
                    &format!("Watchdog: rule violation — {}", reason),
                    &format!("Deterministic rule violated. {}", reason),
                ));
            }
        }
    }

    // Check for active LLM drift events
    // Drift handling runs regardless of enforcement_enabled — the flag controls
    // whether violations result in deny (true) or allow_with_context (false).
    // All audit modes (strict, balanced, guided, learning) need this logic.
    let is_modifying = matches!(payload.tool_name.as_str(), "Write" | "Edit");
    let is_non_modifying = !is_modifying;
    let enforcement = state.inner.read().await.enforcement_for_session(&payload.session_id);

    {
        let inner = state.inner.read().await;

        // If session is halted, deny all modifications (always enforced)
        if inner.session.status == SessionStatus::Halted && is_modifying {
            return Json(PreToolUseResponse::deny(
                "Watchdog: session halted — unresolved drift after repeated corrections. Human intervention required.",
                "This session has been halted by Agent Watchdog. No further file modifications are allowed. The developer has been notified.",
            ));
        }

        // Check for active drifts
        let active_drifts: Vec<_> = inner.active_drifts.values()
            .filter(|d| !matches!(d.state, crate::models::DriftState::Resolved))
            .collect();

        if !active_drifts.is_empty() {
            let mode = inner.audit_mode_for_session(&payload.session_id);

            // Non-modifying tools (Read, Grep, Glob, etc.) always pass through
            // but transition drifts from Notified → CorrectionPending
            if is_non_modifying {
                drop(inner);
                let mut inner_w = state.inner.write().await;
                for drift in inner_w.active_drifts.values_mut() {
                    if drift.state == crate::models::DriftState::Notified {
                        drift.state = crate::models::DriftState::CorrectionPending;
                    }
                }
                let threshold = inner_w.config.escalation_threshold;
                inner_w.session.status = crate::auditor::derive_session_status(&inner_w.active_drifts, threshold);
                return Json(PreToolUseResponse::allow());
            }

            // For modifying tools, determine if this targets a drifted file (correction attempt)
            let target_file = file_path.as_deref();
            let targets_drifted_file = target_file.map(|path| {
                active_drifts.iter().any(|d| d.file_path == path || path.ends_with(&d.file_path) || d.file_path.ends_with(path))
            }).unwrap_or(false);

            // Build feedback from all active drifts
            let feedback: Vec<String> = active_drifts.iter()
                .map(|d| {
                    format!(
                        "Issue: {}\nFile: {}\nReason: {}\nAction: {}\nEvidence: {}\nSeverity: {}",
                        d.finding, d.file_path, d.reason, d.correction,
                        d.evidence.join(", "), d.severity
                    )
                })
                .collect();

            if !feedback.is_empty() {
                let context = feedback.join("\n\n---\n\n");

                // Check if any drift is still in Detected state (not yet notified)
                let has_detected = active_drifts.iter().any(|d| d.state == crate::models::DriftState::Detected);

                match mode.as_str() {
                    "strict" => {
                        // Strict: deny ALL writes when any drift is active
                        let drift_ids: Vec<String> = active_drifts.iter().map(|d| d.id.clone()).collect();
                        drop(inner);
                        let mut inner_w = state.inner.write().await;
                        // Transition Detected → Notified after sending deny
                        for drift in inner_w.active_drifts.values_mut() {
                            if drift.state == crate::models::DriftState::Detected {
                                drift.state = crate::models::DriftState::Notified;
                                drift.notified_at = Some(chrono::Utc::now());
                            }
                        }
                        // Record change_requested for each active drift
                        for did in &drift_ids {
                            inner_w.rules_engine.record_external(AuditTrailEntry {
                                timestamp: chrono::Utc::now(),
                                finding: "enforcement".to_string(),
                                action: "denied".to_string(),
                                source: "semantic".to_string(),
                                rule_type: "change_requested".to_string(),
                                file_path: file_path.as_deref().unwrap_or("").to_string(),
                                tool_name: payload.tool_name.clone(),
                                reason: "Agent denied due to active drift".to_string(),
                                details: serde_json::json!({ "feedback": context }),
                                rule_quote: String::new(),
                                enforcement: true,
                                issue_id: Some(did.clone()),
                                event_type: Some("change_requested".to_string()),
                                agent_session_id: Some(payload.session_id.clone()),
                            });
                        }
                        // Broadcast block event for dashboard shield flash
                        let _ = state.event_tx.send(serde_json::json!({
                            "type": "rule_violation",
                            "timestamp": chrono::Utc::now(),
                            "file_path": file_path.as_deref().unwrap_or(""),
                            "reason": "Drift detected — action blocked",
                            "tool_name": payload.tool_name,
                            "action": "denied",
                        }).to_string());
                        return Json(PreToolUseResponse::deny(
                            "Watchdog: drift detected — action blocked until resolved",
                            &context,
                        ));
                    }
                    "balanced" => {
                        if has_detected && !targets_drifted_file {
                            // First time + NOT targeting a drifted file → deny and transition to Notified
                            let drift_ids: Vec<String> = active_drifts.iter()
                                .filter(|d| d.state == crate::models::DriftState::Detected)
                                .map(|d| d.id.clone()).collect();
                            drop(inner);
                            let mut inner_w = state.inner.write().await;
                            for drift in inner_w.active_drifts.values_mut() {
                                if drift.state == crate::models::DriftState::Detected {
                                    drift.state = crate::models::DriftState::Notified;
                                    drift.notified_at = Some(chrono::Utc::now());
                                }
                            }
                            let threshold = inner_w.config.escalation_threshold;
                            inner_w.session.status = crate::auditor::derive_session_status(&inner_w.active_drifts, threshold);
                            // Record change_requested
                            for did in &drift_ids {
                                inner_w.rules_engine.record_external(AuditTrailEntry {
                                    timestamp: chrono::Utc::now(),
                                    finding: "enforcement".to_string(),
                                    action: "denied".to_string(),
                                    source: "semantic".to_string(),
                                    rule_type: "change_requested".to_string(),
                                    file_path: file_path.as_deref().unwrap_or("").to_string(),
                                    tool_name: payload.tool_name.clone(),
                                    reason: "Agent denied due to active drift".to_string(),
                                    details: serde_json::json!({ "feedback": context }),
                                    rule_quote: String::new(),
                                    enforcement: true,
                                    issue_id: Some(did.clone()),
                                    event_type: Some("change_requested".to_string()),
                                    agent_session_id: Some(payload.session_id.clone()),
                                });
                            }
                            // Broadcast block event for dashboard shield flash
                            let _ = state.event_tx.send(serde_json::json!({
                                "type": "rule_violation",
                                "timestamp": chrono::Utc::now(),
                                "file_path": file_path.as_deref().unwrap_or(""),
                                "reason": "Drift detected — action blocked",
                                "tool_name": payload.tool_name,
                                "action": "denied",
                            }).to_string());
                            return Json(PreToolUseResponse::deny(
                                "Watchdog: drift detected — action blocked. Correct the drift and retry.",
                                &context,
                            ));
                        } else {
                            // Already notified/correction_pending → allow with context (agent_responded)
                            let drift_ids: Vec<String> = active_drifts.iter()
                                .filter(|d| d.state == crate::models::DriftState::Notified || d.state == crate::models::DriftState::CorrectionPending)
                                .map(|d| d.id.clone()).collect();
                            drop(inner);
                            let mut inner_w = state.inner.write().await;
                            for drift in inner_w.active_drifts.values_mut() {
                                if drift.state == crate::models::DriftState::Notified {
                                    drift.state = crate::models::DriftState::CorrectionPending;
                                }
                            }
                            let threshold = inner_w.config.escalation_threshold;
                            inner_w.session.status = crate::auditor::derive_session_status(&inner_w.active_drifts, threshold);
                            // Record agent_responded
                            let command_str = payload.tool_input.get("command")
                                .and_then(|v| v.as_str()).unwrap_or("").to_string();
                            for did in &drift_ids {
                                inner_w.rules_engine.record_external(AuditTrailEntry {
                                    timestamp: chrono::Utc::now(),
                                    finding: "enforcement".to_string(),
                                    action: "warned".to_string(),
                                    source: "semantic".to_string(),
                                    rule_type: "agent_responded".to_string(),
                                    file_path: file_path.as_deref().unwrap_or("").to_string(),
                                    tool_name: payload.tool_name.clone(),
                                    reason: "Agent tool call after drift notification".to_string(),
                                    details: serde_json::json!({ "tool": payload.tool_name, "command": command_str }),
                                    rule_quote: String::new(),
                                    enforcement: true,
                                    issue_id: Some(did.clone()),
                                    event_type: Some("agent_responded".to_string()),
                                    agent_session_id: Some(payload.session_id.clone()),
                                });
                            }
                            return Json(PreToolUseResponse::allow_with_context(
                                &format!("Watchdog notice: Active drift detected. The auditor will re-check on the next cycle.\n\n{}", context),
                            ));
                        }
                    }
                    "guided" => {
                        // Never block — just inject context and transition states
                        let drift_ids: Vec<String> = active_drifts.iter().map(|d| d.id.clone()).collect();
                        let has_newly_detected = active_drifts.iter().any(|d| d.state == crate::models::DriftState::Detected);
                        drop(inner);
                        let mut inner_w = state.inner.write().await;
                        for drift in inner_w.active_drifts.values_mut() {
                            if drift.state == crate::models::DriftState::Detected {
                                drift.state = crate::models::DriftState::Notified;
                                drift.notified_at = Some(chrono::Utc::now());
                            }
                            if drift.state == crate::models::DriftState::Notified {
                                drift.state = crate::models::DriftState::CorrectionPending;
                            }
                        }
                        let threshold = inner_w.config.escalation_threshold;
                        inner_w.session.status = crate::auditor::derive_session_status(&inner_w.active_drifts, threshold);
                        // Record change_requested if newly detected, otherwise agent_responded
                        let evt = if has_newly_detected { "change_requested" } else { "agent_responded" };
                        let action_str = if has_newly_detected { "warned" } else { "warned" };
                        let command_str = payload.tool_input.get("command")
                            .and_then(|v| v.as_str()).unwrap_or("").to_string();
                        for did in &drift_ids {
                            inner_w.rules_engine.record_external(AuditTrailEntry {
                                timestamp: chrono::Utc::now(),
                                finding: "enforcement".to_string(),
                                action: action_str.to_string(),
                                source: "semantic".to_string(),
                                rule_type: evt.to_string(),
                                file_path: file_path.as_deref().unwrap_or("").to_string(),
                                tool_name: payload.tool_name.clone(),
                                reason: if evt == "change_requested" { "Agent warned about drift" } else { "Agent tool call after drift notification" }.to_string(),
                                details: serde_json::json!({ "tool": payload.tool_name, "command": command_str }),
                                rule_quote: String::new(),
                                enforcement: true,
                                issue_id: Some(did.clone()),
                                event_type: Some(evt.to_string()),
                                agent_session_id: Some(payload.session_id.clone()),
                            });
                        }
                        return Json(PreToolUseResponse::allow_with_context(
                            &format!("Watchdog guidance: The auditor detected drift. Consider correcting:\n\n{}", context),
                        ));
                    }
                    "learning" => {
                        // Learning mode: allow correction attempts and spec edits
                        // Block only non-drifted file writes on first encounter
                        if has_detected && !targets_drifted_file {
                            let drift_ids: Vec<String> = active_drifts.iter()
                                .filter(|d| d.state == crate::models::DriftState::Detected)
                                .map(|d| d.id.clone()).collect();
                            drop(inner);
                            let mut inner_w = state.inner.write().await;
                            for drift in inner_w.active_drifts.values_mut() {
                                if drift.state == crate::models::DriftState::Detected {
                                    drift.state = crate::models::DriftState::Notified;
                                    drift.notified_at = Some(chrono::Utc::now());
                                }
                            }
                            for did in &drift_ids {
                                inner_w.rules_engine.record_external(AuditTrailEntry {
                                    timestamp: chrono::Utc::now(),
                                    finding: "enforcement".to_string(),
                                    action: "denied".to_string(),
                                    source: "semantic".to_string(),
                                    rule_type: "change_requested".to_string(),
                                    file_path: file_path.as_deref().unwrap_or("").to_string(),
                                    tool_name: payload.tool_name.clone(),
                                    reason: "Agent denied — address existing drifts before creating new files".to_string(),
                                    details: serde_json::json!({ "feedback": context }),
                                    rule_quote: String::new(),
                                    enforcement: true,
                                    issue_id: Some(did.clone()),
                                    event_type: Some("change_requested".to_string()),
                                    agent_session_id: Some(payload.session_id.clone()),
                                });
                            }
                            return Json(PreToolUseResponse::deny(
                                "Watchdog: drift detected — address existing drifts before creating new files.",
                                &context,
                            ));
                        } else {
                            // Correction attempt or already notified — allow with context
                            drop(inner);
                            let mut inner_w = state.inner.write().await;
                            for drift in inner_w.active_drifts.values_mut() {
                                if drift.state == crate::models::DriftState::Notified {
                                    drift.state = crate::models::DriftState::CorrectionPending;
                                }
                            }
                            let threshold = inner_w.config.escalation_threshold;
                            inner_w.session.status = crate::auditor::derive_session_status(&inner_w.active_drifts, threshold);
                            return Json(PreToolUseResponse::allow_with_context(
                                &format!("Watchdog (learning): Active drift detected. The auditor will re-check on the next cycle.\n\n{}", context),
                            ));
                        }
                    }
                    _ => {} // Unknown mode — pass through
                }
            }
        }
    }

    Json(PreToolUseResponse::allow())
}

/// Check if a write/edit would violate spec rules.
/// Uses the LLM for a quick pre-check if an API key is available.
#[allow(dead_code)]
pub(crate) async fn check_spec_violation(state: &AppState, path: &str, payload: &HookPayload) -> Option<String> {
    let config = state.get_config().await;

    // Need API key and spec
    let api_key = config.anthropic_api_key.as_ref()?;
    if api_key.is_empty() { return None; }
    if !config.auditor_enabled { return None; }

    let spec_path = config.spec_path.as_ref()?;
    let full_spec_path = std::path::Path::new(&config.project_dir).join(spec_path);
    let spec = std::fs::read_to_string(&full_spec_path).ok()?;

    // Calculate the resulting file size
    let file_name = std::path::Path::new(path).file_name()?.to_str()?;
    let ext = std::path::Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("");

    let resulting_lines = match payload.tool_name.as_str() {
        "Write" => {
            let content = payload.tool_input.get("content")?.as_str()?;
            content.lines().count()
        }
        "Edit" => {
            // Read current file, apply the edit mentally
            let current = std::fs::read_to_string(path).unwrap_or_default();
            let old_str = payload.tool_input.get("old_string").and_then(|v| v.as_str()).unwrap_or("");
            let new_str = payload.tool_input.get("new_string").and_then(|v| v.as_str()).unwrap_or("");
            let after = current.replace(old_str, new_str);
            after.lines().count()
        }
        _ => return None,
    };

    // Quick deterministic checks we can do without LLM
    // Parse spec for size rules — look for patterns like "should not exceed N lines"
    let _spec_lower = spec.to_lowercase();
    let ext_lower = ext.to_lowercase();

    // Check for file-type specific size limits
    for line in spec.lines() {
        let line_lower = line.to_lowercase().trim().to_string();

        // Match patterns like "markdown files should not exceed 50 lines"
        // or "Swift files should stay under 200 lines"
        // or "No single file should be larger than 500 lines"
        if let Some(limit) = extract_line_limit(&line_lower, &ext_lower, file_name) {
            if resulting_lines > limit {
                return Some(format!(
                    "File '{}' would have {} lines, exceeding the spec limit of {} lines. Rule: {}",
                    file_name, resulting_lines, limit, line.trim()
                ));
            }
        }
    }

    None
}

/// Try to extract a line limit from a spec rule for the given file extension
pub(crate) fn extract_line_limit(rule: &str, ext: &str, _file_name: &str) -> Option<usize> {
    // Map extension to common names
    let ext_names: Vec<&str> = match ext {
        "md" => vec!["markdown", "md", ".md"],
        "swift" => vec!["swift", ".swift"],
        "rs" => vec!["rust", "rs", ".rs"],
        "ts" | "tsx" => vec!["typescript", "ts", "tsx", ".ts", ".tsx"],
        "js" | "jsx" => vec!["javascript", "js", "jsx", ".js", ".jsx"],
        "py" => vec!["python", "py", ".py"],
        "css" => vec!["css", ".css"],
        "html" => vec!["html", ".html"],
        _ => vec![ext],
    };

    // Check if the rule mentions this file type or "no single file" / "no file"
    let applies = ext_names.iter().any(|name| rule.contains(name))
        || rule.contains("no single file")
        || rule.contains("no file")
        || rule.contains("any file");

    if !applies {
        return None;
    }

    // Extract the number — look for patterns like "exceed N", "under N", "over N", "larger than N", "max N"
    let number_patterns = [
        "exceed ", "under ", "over ", "larger than ", "more than ",
        "max ", "maximum ", "limit of ", "beyond ", "past ",
    ];

    for pattern in number_patterns {
        if let Some(pos) = rule.find(pattern) {
            let after = &rule[pos + pattern.len()..];
            // Extract the number, handling "2k", "2000", etc.
            let num_str: String = after.chars()
                .take_while(|c| c.is_ascii_digit() || *c == 'k' || *c == 'K' || *c == '.')
                .collect();
            if let Some(num) = parse_number(&num_str) {
                return Some(num);
            }
        }
    }

    None
}

pub(crate) fn parse_number(s: &str) -> Option<usize> {
    let s = s.trim().to_lowercase();
    if s.ends_with('k') {
        let num: f64 = s.trim_end_matches('k').parse().ok()?;
        Some((num * 1000.0) as usize)
    } else {
        s.parse::<usize>().ok()
    }
}

/// POST /hook/post-tool-use
/// Receives PostToolUse events from Claude Code.
/// Logs the event to the change log and prints live activity.
pub(crate) async fn handle_post_tool_use(
    State(state): State<AppState>,
    Json(payload): Json<HookPayload>,
) -> impl IntoResponse {
    tracing::debug!(
        tool = %payload.tool_name,
        session = %payload.session_id,
        "PostToolUse hook received"
    );

    // Watch notification for Read operations (post-tool, since read completes before we notify)
    if payload.tool_name == "Read" {
        let (file_path, _) = crate::changelog::extract_file_info(
            &payload.tool_name, &payload.tool_input);

        if let Some(ref path) = file_path {
            let is_watched = {
                let inner = state.inner.read().await;
                let v = inner.lockwatch.lock().unwrap().is_watched(path);
                drop(inner);
                v
            };
            if is_watched {
                let _ = state.event_tx.send(serde_json::json!({
                    "type": "watch_triggered",
                    "timestamp": chrono::Utc::now(),
                    "path": path,
                    "operation": "read",
                    "tool_name": payload.tool_name,
                }).to_string());
            }
        }
    }

    handle_handoff_post(&state, &payload).await;
    state.record_event(&payload).await;
    StatusCode::OK
}

// ── Bash write-path detection ────────────────────────────────────────────────
//
// Parses a shell command string (without executing it) and returns the first
// locked file path it would write to, if any.
//
// Patterns covered:
//   >path  >> path  > path  >> path   (output redirection)
//   tee [-a] path                     (tee writes)
//   cp src dest  /  mv src dest       (destination arg)
//   sed -i[suffix] expr path          (in-place edit, last absolute-path arg)
//
// Deliberately conservative: only flags writes to paths the agent explicitly
// names. Sub-shell, heredoc, and indirect writes are not detected.
fn bash_locked_write(
    command: &str,
    store: &crate::lockwatch::LockWatchStore,
) -> Option<String> {
    let tokens: Vec<&str> = command.split_whitespace().collect();

    // Helper: is this token an absolute path that is locked?
    let locked = |t: &str| -> bool { store.is_locked(t) };

    // 1. Output redirection:  > path  or  >> path  (space-separated or fused)
    for i in 0..tokens.len() {
        let tok = tokens[i];

        if (tok == ">" || tok == ">>") && i + 1 < tokens.len() {
            if locked(tokens[i + 1]) {
                return Some(tokens[i + 1].to_string());
            }
        }

        // Fused form: ">path" or ">>path"
        let rest = tok
            .strip_prefix(">>")
            .or_else(|| tok.strip_prefix(">"));
        if let Some(path) = rest {
            if !path.is_empty() && locked(path) {
                return Some(path.to_string());
            }
        }
    }

    // 2. tee [flags] path [path ...]
    if let Some(i) = tokens.iter().position(|&t| t == "tee") {
        for t in &tokens[i + 1..] {
            if !t.starts_with('-') && locked(t) {
                return Some(t.to_string());
            }
        }
    }

    // 3. cp / mv — destination is the last non-flag argument
    for &cmd in &["cp", "mv"] {
        if let Some(i) = tokens.iter().position(|&t| t == cmd) {
            let dest = tokens[i + 1..]
                .iter()
                .filter(|&&t| !t.starts_with('-'))
                .last()
                .copied();
            if let Some(d) = dest {
                if locked(d) {
                    return Some(d.to_string());
                }
            }
        }
    }

    // 4. sed -i — last absolute-path argument is the target file
    if let Some(i) = tokens.iter().position(|&t| t == "sed") {
        let after = &tokens[i + 1..];
        let has_inplace = after.iter().any(|&t| t == "-i" || t.starts_with("-i"));
        if has_inplace {
            // The file is the last token that looks like an absolute path
            let file = after
                .iter()
                .filter(|&&t| t.starts_with('/'))
                .last()
                .copied();
            if let Some(f) = file {
                if locked(f) {
                    return Some(f.to_string());
                }
            }
        }
    }

    None
}

// ── Handoff lifecycle helpers ────────────────────────────────────────────────

fn is_handoff_path(path: &str) -> bool {
    let name = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    name.starts_with("handoff") && name.ends_with(".md")
}

/// Pre-tool-use handoff tracking: broadcast handoff_creating on writes,
/// mark used when a different session reads the handoff.
async fn handle_handoff_pre(state: &AppState, payload: &HookPayload) {
    let (file_path, _) = crate::changelog::extract_file_info(
        &payload.tool_name, &payload.tool_input);
    let path = match file_path {
        Some(p) => p,
        None => return,
    };
    if !is_handoff_path(&path) { return; }

    match payload.tool_name.as_str() {
        "Write" | "Edit" => {
            let _ = state.event_tx.send(
                serde_json::json!({ "type": "handoff_creating" }).to_string()
            );
        }
        "Read" => {
            // If a *different* session reads the handoff, mark it as used
            let creator = {
                let inner = state.inner.read().await;
                inner.handoff.as_ref().map(|h| h.session_id.clone())
            };
            if let Some(creator_sid) = creator {
                if creator_sid != payload.session_id {
                    let now = chrono::Utc::now();
                    let event_data = {
                        let mut inner = state.inner.write().await;
                        if let Some(ref mut h) = inner.handoff {
                            if h.used_by_session_id.is_none() {
                                h.used_by_session_id = Some(payload.session_id.clone());
                                h.used_at = Some(now);
                                Some((h.path.clone(), payload.session_id.clone()))
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
                }
            }
        }
        _ => {}
    }
}

/// Post-tool-use handoff tracking: upsert HandoffRecord on handoff writes,
/// mark outdated on any other file edit after the handoff was created.
async fn handle_handoff_post(state: &AppState, payload: &HookPayload) {
    let (file_path, _) = crate::changelog::extract_file_info(
        &payload.tool_name, &payload.tool_input);

    // Write/Edit to a handoff file → upsert record, broadcast handoff_updated
    if matches!(payload.tool_name.as_str(), "Write" | "Edit") {
        if let Some(ref path) = file_path {
            if is_handoff_path(path) {
                let now = chrono::Utc::now();
                let event_data = {
                    let mut inner = state.inner.write().await;
                    let session_id = inner.session.agent_session_id.clone()
                        .unwrap_or_else(|| payload.session_id.clone());
                    // Use take/replace to avoid holding a borrow while setting handoff_written
                    let existing = inner.handoff.take();
                    let mut h = existing.unwrap_or_else(|| crate::models::HandoffRecord {
                        id: uuid::Uuid::new_v4().to_string(),
                        session_id: session_id.clone(),
                        path: path.clone(),
                        created_at: now,
                        updated_at: now,
                        is_outdated: false,
                        used_by_session_id: None,
                        used_at: None,
                    });
                    h.updated_at = now;
                    h.path = path.clone();
                    h.is_outdated = false;
                    let h_path = h.path.clone();
                    let h_session = h.session_id.clone();
                    inner.handoff = Some(h);
                    inner.handoff_written = true;
                    (h_path, h_session)
                };
                let _ = state.event_tx.send(serde_json::json!({
                    "type": "handoff_updated",
                    "path": event_data.0,
                    "session_id": event_data.1,
                    "is_outdated": false,
                }).to_string());
                return;
            }
        }
    }

    // Any other file edit after a handoff exists → mark outdated
    let is_file_edit = matches!(payload.tool_name.as_str(), "Write" | "Edit" | "Bash");
    if is_file_edit {
        let needs_outdated = {
            let inner = state.inner.read().await;
            inner.handoff.as_ref().map(|h| !h.is_outdated && h.used_by_session_id.is_none()).unwrap_or(false)
        };
        if needs_outdated {
            let event_data = {
                let mut inner = state.inner.write().await;
                if let Some(ref mut h) = inner.handoff {
                    if !h.is_outdated && h.used_by_session_id.is_none() {
                        h.is_outdated = true;
                        Some((h.path.clone(), h.session_id.clone()))
                    } else { None }
                } else { None }
            };
            if let Some((h_path, h_session)) = event_data {
                let _ = state.event_tx.send(serde_json::json!({
                    "type": "handoff_updated",
                    "path": h_path,
                    "session_id": h_session,
                    "is_outdated": true,
                }).to_string());
            }
        }
    }
}
