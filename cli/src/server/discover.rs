use axum::{
    extract::{Path as AxumPath, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::Path;

use crate::session::AppState;

// ── Data types ──────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ProjectInfo {
    name: String,
    path: String,
    sessions_dir: String,
}

#[derive(Serialize)]
pub struct DiscoveredSession {
    id: String,
    label: Option<String>,
    label_source: Option<String>,  // "transcript" or "user"
    transcript_path: String,
    last_modified: String,  // ISO 8601
    is_active: bool,
    usage: Option<SessionUsage>,
}

#[derive(Serialize)]
pub struct SessionUsage {
    cost: f64,
    model: Option<String>,
    context_pct: u32,
    context_window: u64,
    lines_added: u64,
    lines_removed: u64,
    duration_ms: u64,
}

// ── Handlers ────────────────────────────────────────────────────────

/// GET /api/project — info about the current project this server is running for.
pub(crate) async fn handle_get_project(State(state): State<AppState>) -> impl IntoResponse {
    let config = state.get_config().await;
    let project_dir = &config.project_dir;
    let name = Path::new(project_dir)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| project_dir.to_string());

    let hash = project_dir.replace('/', "-");
    let home = dirs_path();
    let sessions_dir = format!("{}/.claude/projects/{}", home, hash);

    Json(ProjectInfo {
        name,
        path: project_dir.to_string(),
        sessions_dir,
    })
}

/// GET /api/project/sessions — discover all sessions for this project from ~/.claude/projects/.
pub(crate) async fn handle_discover_sessions(State(state): State<AppState>) -> impl IntoResponse {
    let config = state.get_config().await;
    let project_dir = &config.project_dir;

    let sessions = discover_sessions(project_dir);
    Json(serde_json::json!({ "sessions": sessions }))
}

// ── Discovery logic (mirrors Swift ProjectStore.discoverSessions) ───

fn discover_sessions(project_dir: &str) -> Vec<DiscoveredSession> {
    let home = dirs_path();
    let hash = project_dir.replace('/', "-");
    let claude_dir = format!("{}/.claude/projects/{}", home, hash);

    let dir = Path::new(&claude_dir);
    if !dir.exists() {
        return vec![];
    }

    let mut sessions = Vec::new();

    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return vec![],
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".jsonl") {
            continue;
        }

        let session_id = name.trim_end_matches(".jsonl").to_string();

        let modified = fs::metadata(&path)
            .ok()
            .and_then(|m| m.modified().ok())
            .map(|t| {
                let dt: chrono::DateTime<chrono::Utc> = t.into();
                dt.to_rfc3339()
            })
            .unwrap_or_default();

        let is_active = fs::metadata(&path)
            .ok()
            .and_then(|m| m.modified().ok())
            .map(|t| t.elapsed().map(|d| d.as_secs() < 3600).unwrap_or(false))
            .unwrap_or(false);

        // Parse transcript for label and usage
        let transcript_path = path.to_string_lossy().to_string();
        let (label, label_source) = parse_session_label(&transcript_path);
        let usage = parse_agent_json(&session_id).or_else(|| parse_transcript_usage(&transcript_path));

        sessions.push(DiscoveredSession {
            id: session_id,
            label,
            label_source,
            transcript_path,
            last_modified: modified,
            is_active,
            usage,
        });
    }

    // Sort: active first, then by modification date descending
    sessions.sort_by(|a, b| {
        b.is_active.cmp(&a.is_active)
            .then_with(|| b.last_modified.cmp(&a.last_modified))
    });

    sessions
}

/// Parse the last custom-title or first user message from a transcript JSONL.
fn parse_session_label(transcript_path: &str) -> (Option<String>, Option<String>) {
    let content = match fs::read_to_string(transcript_path) {
        Ok(c) => c,
        Err(_) => return (None, None),
    };

    let mut last_custom_title: Option<String> = None;
    let mut first_user_message: Option<String> = None;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }

        let json: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let msg_type = json.get("type").and_then(|v| v.as_str()).unwrap_or("");

        if msg_type == "custom-title" {
            if let Some(title) = json.get("customTitle").and_then(|v| v.as_str()) {
                if !title.is_empty() {
                    last_custom_title = Some(title.to_string());
                }
            }
        }

        if first_user_message.is_none() && (msg_type == "human" || msg_type == "user") {
            let text = json.get("message").and_then(|v| v.as_str())
                .or_else(|| json.get("content").and_then(|v| v.as_str()));
            if let Some(t) = text {
                if !t.is_empty() {
                    let truncated: String = t.chars().take(60).collect();
                    first_user_message = Some(truncated);
                }
            } else if let Some(parts) = json.get("content").and_then(|v| v.as_array()) {
                for part in parts {
                    if let Some(t) = part.get("text").and_then(|v| v.as_str()) {
                        if !t.is_empty() {
                            let truncated: String = t.chars().take(60).collect();
                            first_user_message = Some(truncated);
                            break;
                        }
                    }
                }
            }
        }
    }

    if let Some(title) = last_custom_title {
        (Some(title), Some("transcript".to_string()))
    } else if let Some(msg) = first_user_message {
        (Some(msg), Some("transcript".to_string()))
    } else {
        (None, None)
    }
}

/// Try to read usage from .agent.json files (written by statusline snippet).
fn parse_agent_json(session_id: &str) -> Option<SessionUsage> {
    let home = dirs_path();
    let usage_dir = format!("{}/.claude/usage", home);
    let usage_path = Path::new(&usage_dir);
    if !usage_path.exists() { return None; }

    let mut best: Option<(serde_json::Value, u64)> = None;

    // Scan date directories (most recent first)
    let mut date_dirs: Vec<_> = fs::read_dir(usage_path).ok()?
        .flatten()
        .filter(|e| e.path().is_dir())
        .collect();
    date_dirs.sort_by(|a, b| b.file_name().cmp(&a.file_name()));

    for date_dir in date_dirs {
        let files = match fs::read_dir(date_dir.path()) {
            Ok(f) => f,
            Err(_) => continue,
        };

        for file in files.flatten() {
            let fname = file.file_name().to_string_lossy().to_string();
            if !fname.ends_with(".agent.json") { continue; }

            let data = match fs::read_to_string(file.path()) {
                Ok(d) => d,
                Err(_) => continue,
            };

            let json: serde_json::Value = match serde_json::from_str(&data) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let sid = json.get("session_id").and_then(|v| v.as_str()).unwrap_or("");
            if sid != session_id { continue; }

            let updated_at = json.get("updated_at").and_then(|v| v.as_u64()).unwrap_or(0);
            if best.is_none() || updated_at > best.as_ref().unwrap().1 {
                best = Some((json, updated_at));
            }
        }

        // If found in most recent date dir, stop scanning older ones
        if best.is_some() { break; }
    }

    let (json, _) = best?;
    Some(SessionUsage {
        cost: json.get("cost").and_then(|v| v.as_f64()).unwrap_or(0.0),
        model: json.get("model").and_then(|v| v.as_str()).map(|s| s.to_string()),
        context_pct: json.get("context_pct").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        context_window: json.get("context_window").and_then(|v| v.as_u64()).unwrap_or(200_000),
        lines_added: json.get("lines_added").and_then(|v| v.as_u64()).unwrap_or(0),
        lines_removed: json.get("lines_removed").and_then(|v| v.as_u64()).unwrap_or(0),
        duration_ms: json.get("duration_ms").and_then(|v| v.as_u64()).unwrap_or(0),
    })
}

/// Fallback: parse usage from transcript JSONL directly.
fn parse_transcript_usage(transcript_path: &str) -> Option<SessionUsage> {
    let content = fs::read_to_string(transcript_path).ok()?;

    let mut total_input: u64 = 0;
    let mut total_output: u64 = 0;
    let mut total_cache_creation: u64 = 0;
    let mut total_cache_read: u64 = 0;
    let mut latest_context_tokens: u64 = 0;
    let mut latest_model: Option<String> = None;
    let mut message_count: u64 = 0;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }

        let json: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let msg_type = json.get("type").and_then(|v| v.as_str()).unwrap_or("");

        if msg_type == "human" || msg_type == "user" || msg_type == "assistant" {
            message_count += 1;
        }

        if msg_type == "assistant" {
            if let Some(usage) = json.get("message").and_then(|m| m.get("usage")) {
                let input = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let output = usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let cache_creation = usage.get("cache_creation_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let cache_read = usage.get("cache_read_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);

                total_input += input;
                total_output += output;
                total_cache_creation += cache_creation;
                total_cache_read += cache_read;
                latest_context_tokens = input + cache_read;
            }
            if let Some(model) = json.get("message").and_then(|m| m.get("model")).and_then(|v| v.as_str()) {
                latest_model = Some(model.to_string());
            }
        }
    }

    if message_count == 0 { return None; }

    // Pricing (simplified — same as Swift TranscriptParser)
    let (input_rate, output_rate, cache_write_rate, cache_read_rate, context_limit) =
        if latest_model.as_deref().map(|m| m.contains("opus")).unwrap_or(false) {
            (15.0, 75.0, 5.5, 0.435, 1_000_000u64)
        } else if latest_model.as_deref().map(|m| m.contains("haiku")).unwrap_or(false) {
            (0.8, 4.0, 0.293, 0.023, 200_000u64)
        } else {
            (3.0, 15.0, 1.1, 0.087, 200_000u64)
        };

    let cost = (total_input as f64 * input_rate
        + total_output as f64 * output_rate
        + total_cache_creation as f64 * cache_write_rate
        + total_cache_read as f64 * cache_read_rate) / 1_000_000.0;

    let context_pct = if context_limit > 0 {
        ((latest_context_tokens as f64 / context_limit as f64) * 100.0) as u32
    } else { 0 };

    Some(SessionUsage {
        cost,
        model: latest_model,
        context_pct,
        context_window: context_limit,
        lines_added: 0,
        lines_removed: 0,
        duration_ms: 0,
    })
}

fn dirs_path() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string())
}

// ── Session label endpoint ──────────────────────────────────────────

#[derive(Deserialize)]
pub struct LabelBody {
    label: String,
}

/// POST /api/project/sessions/:id/label
/// Writes a custom-title JSON line to the session transcript (mirrors Swift appendCustomTitle).
pub(crate) async fn handle_set_session_label(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
    Json(body): Json<LabelBody>,
) -> impl IntoResponse {
    let config = state.get_config().await;
    let project_dir = &config.project_dir;

    let hash = project_dir.replace('/', "-");
    let home = dirs_path();
    let transcript_path = format!("{}/.claude/projects/{}/{}.jsonl", home, hash, session_id);

    if !std::path::Path::new(&transcript_path).exists() {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "session not found"}))).into_response();
    }

    // Build the custom-title JSON line (matches Swift appendCustomTitle format)
    let entry = serde_json::json!({
        "type": "custom-title",
        "customTitle": body.label,
        "sessionId": session_id
    });
    let line = format!("\n{}\n", entry);

    // Append to transcript
    match fs::OpenOptions::new().append(true).open(&transcript_path) {
        Ok(mut file) => {
            if file.write_all(line.as_bytes()).is_err() {
                return (StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": "write failed"}))).into_response();
            }
        }
        Err(_) => {
            return (StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "could not open transcript"}))).into_response();
        }
    }

    Json(serde_json::json!({"ok": true})).into_response()
}
