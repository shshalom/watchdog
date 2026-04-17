use chrono::{DateTime, Utc};
use serde::Deserialize;
use std::path::Path;
use tracing::info;

/// A file operation extracted from the transcript.
#[derive(Debug, Clone)]
pub struct TranscriptFileOp {
    pub tool_name: String,
    pub file_path: String,
    pub operation: crate::models::FileOperation,
    /// For Edit: (old_string, new_string)
    pub edit_pair: Option<(String, String)>,
    /// For Write: the full content written
    pub write_content: Option<String>,
    /// For Bash: the command
    pub bash_command: Option<String>,
    pub timestamp: DateTime<Utc>,
}

/// Minimal structure to parse transcript JSONL entries.
#[derive(Debug, Deserialize)]
struct TranscriptEntry {
    #[serde(rename = "type")]
    entry_type: String,
    #[serde(default)]
    message: Option<TranscriptMessage>,
    #[serde(default)]
    timestamp: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TranscriptMessage {
    #[serde(default)]
    role: String,
    #[serde(default)]
    content: serde_json::Value,
}

/// Parse a Claude Code transcript JSONL file and extract all file operations.
pub fn parse_transcript(path: &Path) -> Vec<TranscriptFileOp> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("Failed to read transcript {}: {}", path.display(), e);
            return vec![];
        }
    };

    let mut ops = Vec::new();

    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }

        let entry: TranscriptEntry = match serde_json::from_str(line) {
            Ok(e) => e,
            Err(_) => continue,
        };

        // We only care about assistant messages with tool_use
        if entry.entry_type != "assistant" {
            continue;
        }

        let message = match entry.message {
            Some(m) if m.role == "assistant" => m,
            _ => continue,
        };

        let timestamp = entry.timestamp
            .and_then(|t| t.parse::<DateTime<Utc>>().ok())
            .unwrap_or_else(Utc::now);

        // Content can be an array of blocks
        let content_arr = match message.content.as_array() {
            Some(arr) => arr,
            None => continue,
        };

        for block in content_arr {
            let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if block_type != "tool_use" {
                continue;
            }

            let tool_name = block.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let input = match block.get("input") {
                Some(i) => i,
                None => continue,
            };

            match tool_name {
                "Write" => {
                    if let Some(fp) = input.get("file_path").and_then(|v| v.as_str()) {
                        let content = input.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        ops.push(TranscriptFileOp {
                            tool_name: "Write".to_string(),
                            file_path: fp.to_string(),
                            operation: crate::models::FileOperation::Create,
                            edit_pair: None,
                            write_content: Some(content),
                            bash_command: None,
                            timestamp,
                        });
                    }
                }
                "Edit" => {
                    if let Some(fp) = input.get("file_path").and_then(|v| v.as_str()) {
                        let old_str = input.get("old_string").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let new_str = input.get("new_string").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        ops.push(TranscriptFileOp {
                            tool_name: "Edit".to_string(),
                            file_path: fp.to_string(),
                            operation: crate::models::FileOperation::Modify,
                            edit_pair: Some((old_str, new_str)),
                            write_content: None,
                            bash_command: None,
                            timestamp,
                        });
                    }
                }
                "Bash" => {
                    let cmd = input.get("command").and_then(|v| v.as_str()).unwrap_or("");
                    // Extract file path from rm/mv/etc commands
                    if let Some(fp) = crate::changelog::parse_bash_file_path(cmd) {
                        let op = if cmd.trim().starts_with("rm") {
                            crate::models::FileOperation::Delete
                        } else {
                            crate::models::FileOperation::Bash
                        };
                        ops.push(TranscriptFileOp {
                            tool_name: "Bash".to_string(),
                            file_path: fp,
                            operation: op,
                            edit_pair: None,
                            write_content: None,
                            bash_command: Some(cmd.to_string()),
                            timestamp,
                        });
                    }
                }
                _ => {}
            }
        }
    }

    info!("Parsed {} file operations from transcript", ops.len());
    ops
}

/// Make parse_bash_file_path accessible from this module
pub use crate::changelog::parse_bash_file_path;
