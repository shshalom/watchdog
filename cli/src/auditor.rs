use crate::models::*;
use crate::session::AppState;
use serde::Deserialize;
use std::collections::HashMap;
use tracing::{info, warn, error};

/// Result of auditing a single file
#[derive(Debug, Clone, serde::Serialize)]
pub struct AuditResult {
    pub path: String,
    pub verdict: String, // "aligned" or "drift"
    pub reason: Option<String>, // why aligned or drifted
    pub issue: Option<AuditIssue>,
    /// Spec line numbers the auditor referenced during evaluation
    pub spec_lines: Vec<SpecLineRef>,
}

/// A reference to a specific line in a specific spec file
#[derive(Debug, Clone, serde::Serialize)]
pub struct SpecLineRef {
    pub spec_path: String,
    pub line: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AuditIssue {
    pub issue_type: String,
    pub reason: String,
    pub evidence: Vec<String>,
    pub severity: String,
    pub correction: String,
}

/// Response from the LLM auditor
#[derive(Debug, Deserialize)]
struct LLMResponse {
    content: Vec<ContentBlock>,
}

#[derive(Debug, Deserialize)]
struct ContentBlock {
    #[serde(rename = "type")]
    block_type: String,
    text: Option<String>,
}

/// Run the auditor loop in the background
pub async fn run_auditor_loop(state: AppState) {
    info!("Auditor loop started");

    loop {
        let config = state.get_config().await;

        if !config.auditor_enabled {
            tracing::warn!("Auditor disabled, sleeping 5s");
            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
            continue;
        }

        let interval = config.batch_interval_seconds;
        tracing::debug!("Auditor sleeping {}s before next cycle", interval);
        tokio::select! {
            _ = tokio::time::sleep(tokio::time::Duration::from_secs(interval)) => {},
            _ = state.audit_trigger.notified() => {
                info!("Auditor triggered early by correction attempt");
            },
        }

        // Check if we have an API key and files to audit
        let api_key = match config.anthropic_api_key {
            Some(ref key) if !key.is_empty() => key.clone(),
            _ => {
                tracing::warn!("Auditor: no API key, skipping cycle");
                continue;
            }
        };

        // Load all spec files
        let spec_paths = if config.spec_paths.is_empty() {
            config.spec_path.iter().cloned().collect::<Vec<_>>()
        } else {
            config.spec_paths.clone()
        };
        if spec_paths.is_empty() { continue; }

        let mut specs: Vec<(String, String)> = Vec::new(); // (path, content)
        for path in &spec_paths {
            let p = std::path::Path::new(path);
            let full_path = if p.is_absolute() {
                p.to_path_buf()
            } else {
                // Try project_dir join first, fall back to prepending /
                let joined = std::path::Path::new(&config.project_dir).join(path);
                if joined.exists() { joined } else {
                    let with_slash = std::path::PathBuf::from(format!("/{}", path));
                    if with_slash.exists() { with_slash } else { joined }
                }
            };
            if let Ok(content) = std::fs::read_to_string(&full_path) {
                specs.push((path.clone(), content));
            }
        }
        if specs.is_empty() { continue; }

        // Combine specs for the prompt, numbering each line for reference
        let spec = specs.iter()
            .map(|(path, content)| {
                let numbered = content.lines()
                    .enumerate()
                    .map(|(i, line)| format!("{}: {}", i + 1, line))
                    .collect::<Vec<_>>()
                    .join("\n");
                format!("### Spec: {}\n\n{}", path, numbered)
            })
            .collect::<Vec<_>>()
            .join("\n\n---\n\n");

        // Detect spec changes — if specs were modified, re-queue drifted files for re-audit
        {
            use std::hash::{Hash, Hasher};
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            spec.hash(&mut hasher);
            let spec_hash = hasher.finish();

            let mut inner = state.inner.write().await;
            if inner.last_spec_hash != 0 && spec_hash != inner.last_spec_hash {
                // Specs changed — re-queue all actively drifted files
                let drift_paths: Vec<String> = inner.active_drifts.keys().cloned().collect();
                if !drift_paths.is_empty() {
                    info!("Specs changed — re-queuing {} drifted files for re-audit", drift_paths.len());
                    for path in &drift_paths {
                        if let Some(tracked) = inner.tracked_files.get_mut(path) {
                            tracked.audit_status = "pending".to_string();
                        }
                    }
                }
            }
            inner.last_spec_hash = spec_hash;
        }

        // Check for deleted files that had active drifts — resolve them
        {
            let mut inner = state.inner.write().await;
            let agent_sid = inner.session.agent_session_id.clone();
            let drift_paths: Vec<String> = inner.active_drifts.keys().cloned().collect();
            tracing::debug!("Checking {} active drifts for deleted files: {:?}", drift_paths.len(), drift_paths);
            for drift_path in drift_paths {
                let exists = std::path::Path::new(&drift_path).exists();
                tracing::debug!("  drift path '{}' exists={}", drift_path, exists);
                if !exists {
                    // File was deleted — treat drift as resolved
                    if let Some(mut drift) = inner.active_drifts.remove(&drift_path) {
                        let drift_id = drift.id.clone();
                        drift.state = DriftState::Resolved;
                        drift.resolved_at = Some(chrono::Utc::now());
                        let correction_attempts = drift.correction_attempts;
                        info!("Drift resolved by deletion for {} (drift {})", drift_path, drift_id);

                        // Update tracked file status to aligned
                        if let Some(tracked) = inner.tracked_files.get_mut(&drift_path) {
                            tracked.audit_status = "aligned".to_string();
                        }

                        // Record issue_resolved audit trail entry
                        let enforcement = inner.config.enforcement_enabled;
                        inner.rules_engine.record_external(crate::rules::AuditTrailEntry {
                            timestamp: chrono::Utc::now(),
                            finding: "aligned".to_string(),
                            action: "observed".to_string(),
                            source: "semantic".to_string(),
                            rule_type: "semantic_audit".to_string(),
                            file_path: drift_path.clone(),
                            tool_name: "LLM Auditor".to_string(),
                            reason: "Drift resolved: file deleted".to_string(),
                            details: serde_json::json!({
                                "resolution": "file_deleted",
                                "correction_attempts": correction_attempts,
                            }),
                            rule_quote: String::new(),
                            enforcement,
                            issue_id: Some(drift_id.clone()),
                            event_type: Some("issue_resolved".to_string()),
                            agent_session_id: agent_sid.clone(),
                        });

                        // Broadcast drift_resolved WebSocket event
                        let event = serde_json::json!({
                            "type": "drift_resolved",
                            "drift_event_id": drift_id,
                            "file_path": drift_path,
                            "correction_attempts": correction_attempts,
                            "resolution": "file_deleted",
                        });
                        let _ = state.event_tx.send(event.to_string());
                    }
                }
            }
            // Update session status after potential resolutions
            let threshold = inner.config.escalation_threshold;
            inner.session.status = derive_session_status(&inner.active_drifts, threshold);

            // Ensure active drift files are in tracked_files for re-audit (first cycle only)
            let drift_files: Vec<String> = inner.active_drifts.values()
                .map(|d| d.file_path.clone())
                .collect();
            for drift_path in &drift_files {
                if !inner.tracked_files.contains_key(drift_path) {
                    // Not yet tracked — add as pending so the auditor re-verifies
                    let dir = std::path::Path::new(drift_path)
                        .parent()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_default();
                    inner.tracked_files.insert(drift_path.clone(), TrackedFile {
                        path: drift_path.clone(),
                        operation: FileOperation::Modify,
                        timestamp: chrono::Utc::now(),
                        audit_status: "pending".to_string(),
                        change_size: 0,
                        directory: dir,
                        imports: vec![],
                        session_id: None, // Drift re-audit, not tied to a specific session
                    });
                }
                // Already tracked — don't reset to pending every cycle
            }
        }

        // Get files that haven't been audited yet
        let files = state.get_tracked_files().await;
        let pending: Vec<_> = files.iter()
            .filter(|f| f.audit_status == "pending")
            .filter(|f| matches!(f.operation, FileOperation::Create | FileOperation::Modify))
            .collect();

        if pending.is_empty() {
            tracing::debug!("Auditor: no pending Create/Modify files, skipping");
            continue;
        }

        info!("Auditing {} pending files", pending.len());

        // Broadcast batch_started so dashboard shows auditor is working
        let batch_id = chrono::Utc::now().timestamp();
        let batch_started_event = serde_json::json!({
            "type": "batch_started",
            "batch_id": batch_id,
            "timestamp": chrono::Utc::now(),
            "files_queued": pending.len(),
        });
        let _ = state.event_tx.send(batch_started_event.to_string());

        // Build the audit request
        let mut file_summaries = String::new();
        for file in &pending {
            let content = std::fs::read_to_string(&file.path).unwrap_or_default();
            let line_count = content.lines().count();
            let ext = std::path::Path::new(&file.path)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("unknown");

            file_summaries.push_str(&format!(
                "\n## File: {}\n- Operation: {:?}\n- Extension: {}\n- Lines: {}\n- Directory: {}\n\nContent (first 100 lines):\n```\n{}\n```\n",
                file.path,
                file.operation,
                ext,
                line_count,
                file.directory,
                content.lines().take(100).collect::<Vec<_>>().join("\n")
            ));
        }

        let prompt = format!(
            "You are an auditor for a coding agent. Evaluate these file changes ONLY against the spec documents provided below.\n\
            IMPORTANT: Only flag drift if a file violates a rule explicitly stated in the provided specs. Do NOT use external knowledge, \
            other files in the project, or inferred conventions. If no spec rule is violated, the verdict is \"aligned\".\n\
            NOTE: Each spec line is numbered (e.g. \"1: line content\"). In your response, include \"spec_lines\" — the line numbers you \
            evaluated against, as objects with \"spec_path\" and \"line\" fields.\n\n\
            # SPEC\n{}\n\n\
            # FILE CHANGES\n{}\n\n\
            For each file, evaluate in order. On the FIRST drift found, STOP and return only that file.\n\n\
            Respond with ONLY valid JSON (no markdown, no explanation outside JSON):\n\
            {{\n  \"results\": [\n    {{\n      \"path\": \"file path\",\n      \"verdict\": \"aligned\" or \"drift\",\n      \
            \"reason\": \"brief explanation of what was checked and why it passed or drifted\",\n      \
            \"spec_lines\": [{{\"spec_path\": \"path/to/spec.md\", \"line\": 5}}],\n      \
            \"issue\": null or {{\n        \"issue_type\": \"type\",\n        \"reason\": \"why\",\n        \
            \"evidence\": [\"spec rule cited\"],\n        \"severity\": \"soft_warning\" or \"strong_warning\" or \"hard_stop\",\n        \
            \"correction\": \"what to do\"\n      }}\n    }}\n  ]\n}}",
            spec, file_summaries
        );

        // Call the Anthropic API
        match call_anthropic(&api_key, &config.auditor_model, &prompt).await {
            Ok(response_text) => {
                match parse_audit_response(&response_text) {
                    Ok(results) => {
                        process_audit_results(&state, results).await;
                    }
                    Err(e) => {
                        warn!("Failed to parse audit response: {}", e);
                    }
                }
            }
            Err(e) => {
                error!("Auditor API call failed: {}", e);
            }
        }
    }
}

async fn call_anthropic(api_key: &str, model: &str, prompt: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let client = reqwest::Client::new();

    let body = serde_json::json!({
        "model": model,
        "max_tokens": 4096,
        "messages": [
            {
                "role": "user",
                "content": prompt
            }
        ]
    });

    let response = client.post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Anthropic API error {}: {}", status, text).into());
    }

    let llm_response: LLMResponse = response.json().await?;

    let text = llm_response.content.iter()
        .filter(|b| b.block_type == "text")
        .filter_map(|b| b.text.clone())
        .collect::<Vec<String>>()
        .join("");

    Ok(text)
}

fn parse_audit_response(text: &str) -> Result<Vec<AuditResult>, String> {
    // Try to extract JSON from the response (might be wrapped in markdown)
    let json_str = if let Some(start) = text.find('{') {
        if let Some(end) = text.rfind('}') {
            &text[start..=end]
        } else {
            text
        }
    } else {
        text
    };

    #[derive(Deserialize)]
    struct AuditResponse {
        results: Vec<AuditResultRaw>,
    }

    #[derive(Deserialize)]
    struct AuditResultRaw {
        path: String,
        verdict: String,
        reason: Option<String>,
        #[serde(default)]
        spec_lines: Vec<SpecLineRefRaw>,
        issue: Option<AuditIssueRaw>,
    }

    #[derive(Deserialize)]
    struct SpecLineRefRaw {
        spec_path: String,
        line: usize,
    }

    #[derive(Deserialize)]
    struct AuditIssueRaw {
        issue_type: String,
        reason: String,
        evidence: Vec<String>,
        severity: String,
        correction: String,
    }

    let parsed: AuditResponse = serde_json::from_str(json_str)
        .map_err(|e| format!("JSON parse error: {} in: {}", e, &json_str[..json_str.len().min(200)]))?;

    Ok(parsed.results.into_iter().map(|r| AuditResult {
        path: r.path,
        verdict: r.verdict,
        reason: r.reason,
        spec_lines: r.spec_lines.into_iter().map(|s| SpecLineRef {
            spec_path: s.spec_path,
            line: s.line,
        }).collect(),
        issue: r.issue.map(|i| AuditIssue {
            issue_type: i.issue_type,
            reason: i.reason,
            evidence: i.evidence,
            severity: i.severity,
            correction: i.correction,
        }),
    }).collect())
}

/// Derive session status from aggregate drift states
pub fn derive_session_status(active_drifts: &HashMap<String, DriftEvent>, escalation_threshold: usize) -> SessionStatus {
    if active_drifts.is_empty() {
        return SessionStatus::Observing;
    }

    // Check if any drift has hit escalation threshold
    if active_drifts.values().any(|d| d.correction_attempts >= escalation_threshold) {
        return SessionStatus::Halted;
    }

    // Check if any drift is in detected or notified state
    let has_detected_or_notified = active_drifts.values().any(|d| {
        matches!(d.state, DriftState::Detected | DriftState::Notified)
    });
    if has_detected_or_notified {
        return SessionStatus::DriftDetected;
    }

    // All remaining drifts must be in correction_pending
    let all_correction_pending = active_drifts.values().all(|d| {
        matches!(d.state, DriftState::CorrectionPending)
    });
    if all_correction_pending {
        return SessionStatus::Correcting;
    }

    SessionStatus::DriftDetected
}

async fn process_audit_results(state: &AppState, results: Vec<AuditResult>) {
    let mut inner = state.inner.write().await;
    let enforcement = inner.config.enforcement_enabled;
    let agent_sid = inner.session.agent_session_id.clone();

    for result in &results {
        // Find the tracked file — match by exact path or by filename suffix
        let matched_path = inner.tracked_files.keys()
            .find(|k| *k == &result.path || k.ends_with(&result.path) || k.ends_with(&format!("/{}", result.path)))
            .cloned();

        if let Some(ref path) = matched_path {
            if let Some(tracked) = inner.tracked_files.get_mut(path) {
                tracked.audit_status = result.verdict.clone();
            }
        }

        let file_path = matched_path.as_deref().unwrap_or(&result.path);

        if result.verdict == "drift" {
            if let Some(ref issue) = result.issue {
                info!(
                    "DRIFT DETECTED: {} — {} ({})",
                    file_path, issue.reason, issue.severity
                );

                // Check if there's an existing drift for this file (re-evaluation)
                let existing_drift = inner.active_drifts.get(file_path);
                let was_pending_or_notified = existing_drift.map(|d| {
                    matches!(d.state, DriftState::CorrectionPending | DriftState::Notified)
                }).unwrap_or(false);

                let prev_attempts = existing_drift.map(|d| d.correction_attempts).unwrap_or(0);
                let prev_detected_at = existing_drift.map(|d| d.detected_at);

                // Determine correction_attempts: increment if re-entering from correction_pending/notified
                let correction_attempts = if was_pending_or_notified {
                    prev_attempts + 1
                } else if prev_attempts > 0 {
                    prev_attempts
                } else {
                    1
                };

                // Reuse existing drift ID if file already has an active drift, otherwise create new
                let drift_id = inner.active_drifts.get(file_path)
                    .map(|d| d.id.clone())
                    .unwrap_or_else(|| format!("drift-{}", chrono::Utc::now().timestamp()));
                let drift_event = DriftEvent {
                    id: drift_id.clone(),
                    file_path: file_path.to_string(),
                    finding: "drift".to_string(),
                    rule_type: issue.issue_type.clone(),
                    reason: issue.reason.clone(),
                    correction: issue.correction.clone(),
                    evidence: issue.evidence.clone(),
                    severity: issue.severity.clone(),
                    source: "semantic".to_string(),
                    state: DriftState::Detected,
                    detected_at: prev_detected_at.unwrap_or_else(chrono::Utc::now),
                    notified_at: None,
                    resolved_at: None,
                    correction_attempts,
                };
                inner.active_drifts.insert(file_path.to_string(), drift_event);

                // Check escalation threshold
                let threshold = inner.config.escalation_threshold;
                if correction_attempts >= threshold {
                    inner.session.status = SessionStatus::Halted;
                    info!("SESSION HALTED: escalation threshold reached for {} ({}/{})", file_path, correction_attempts, threshold);
                } else {
                    // Derive session status from aggregate
                    inner.session.status = derive_session_status(&inner.active_drifts, threshold);
                }

                // Record in audit trail with issue thread event type
                let enforcement = inner.config.enforcement_enabled;
                let thread_event_type = if was_pending_or_notified {
                    "escalated"
                } else {
                    "issue_detected"
                };
                inner.rules_engine.record_external(crate::rules::AuditTrailEntry {
                    timestamp: chrono::Utc::now(),
                    finding: "drift".to_string(),
                    action: if enforcement { "denied" } else { "observed" }.to_string(),
                    source: "semantic".to_string(),
                    rule_type: issue.issue_type.clone(),
                    file_path: file_path.to_string(),
                    tool_name: "LLM Auditor".to_string(),
                    reason: issue.reason.clone(),
                    details: serde_json::json!({
                        "severity": issue.severity,
                        "correction": issue.correction,
                        "evidence": issue.evidence,
                        "correction_attempts": correction_attempts,
                        "was_recheck": was_pending_or_notified,
                        "spec_lines": result.spec_lines,
                    }),
                    rule_quote: issue.evidence.first().cloned().unwrap_or_default(),
                    enforcement,
                    issue_id: Some(drift_id.clone()),
                    event_type: Some(thread_event_type.to_string()),
                    agent_session_id: agent_sid.clone(),
                });

                // Broadcast drift event via WebSocket
                let event = serde_json::json!({
                    "type": "drift_detected",
                    "drift_event_id": drift_id,
                    "file_path": file_path,
                    "severity": issue.severity,
                    "reason": issue.reason,
                    "correction": issue.correction,
                    "evidence": issue.evidence,
                    "state": "detected",
                    "correction_attempts": correction_attempts,
                    "spec_lines": result.spec_lines,
                });
                let _ = state.event_tx.send(event.to_string());
            }

            // Stop on first drift
            break;
        } else {
            info!("ALIGNED: {}", file_path);

            // Check if this file had an active drift — if so, transition to Resolved
            let resolved_drift_id = if let Some(mut drift) = inner.active_drifts.remove(file_path) {
                drift.state = DriftState::Resolved;
                drift.resolved_at = Some(chrono::Utc::now());
                let drift_id = drift.id.clone();
                info!("Drift resolved for {} (was {:?})", file_path, drift.state);

                // Broadcast resolution
                let event = serde_json::json!({
                    "type": "drift_resolved",
                    "drift_event_id": drift_id,
                    "file_path": file_path,
                    "correction_attempts": drift.correction_attempts,
                });
                let _ = state.event_tx.send(event.to_string());
                Some(drift_id)
            } else {
                None
            };

            // Derive session status from remaining active drifts
            let threshold = inner.config.escalation_threshold;
            inner.session.status = derive_session_status(&inner.active_drifts, threshold);

            // Record in trail — if resolving a drift, mark as issue_resolved
            let (evt_type, iid) = if let Some(ref did) = resolved_drift_id {
                (Some("issue_resolved".to_string()), Some(did.clone()))
            } else {
                (None, None)
            };
            inner.rules_engine.record_external(crate::rules::AuditTrailEntry {
                timestamp: chrono::Utc::now(),
                finding: "aligned".to_string(),
                action: "observed".to_string(),
                source: "semantic".to_string(),
                rule_type: "semantic_audit".to_string(),
                file_path: file_path.to_string(),
                tool_name: "LLM Auditor".to_string(),
                reason: result.reason.clone().unwrap_or_else(|| "Aligned with spec".to_string()),
                details: serde_json::json!({
                    "spec_lines": result.spec_lines,
                }),
                rule_quote: String::new(),
                enforcement,
                issue_id: iid,
                event_type: evt_type,
                agent_session_id: None,
            });
        }
    }

    // Collect all spec_lines from this audit cycle
    let all_spec_lines: Vec<&SpecLineRef> = results.iter()
        .flat_map(|r| r.spec_lines.iter())
        .collect();

    // If no drift found, mark all pending as aligned
    if !results.iter().any(|r| r.verdict == "drift") {
        // Broadcast audit complete
        let event = serde_json::json!({
            "type": "audit_complete",
            "batch_id": chrono::Utc::now().timestamp(),
            "timestamp": chrono::Utc::now(),
            "verdict": "aligned",
            "files_evaluated": results.len(),
            "spec_lines": all_spec_lines,
        });
        let _ = state.event_tx.send(event.to_string());
    } else {
        // Broadcast audit complete with drift
        let event = serde_json::json!({
            "type": "audit_complete",
            "batch_id": chrono::Utc::now().timestamp(),
            "timestamp": chrono::Utc::now(),
            "verdict": "drift",
            "files_evaluated": results.len(),
            "spec_lines": all_spec_lines,
        });
        let _ = state.event_tx.send(event.to_string());
    }
}
