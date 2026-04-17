use crate::models::{ChangeLogEntry, FileOperation};
use chrono::Utc;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Manages the append-only JSONL change log for a session.
pub struct ChangeLog {
    path: PathBuf,
}

impl ChangeLog {
    /// Create a new change log at the given directory.
    /// Creates the directory and file if they don't exist.
    pub fn new(session_dir: &Path) -> std::io::Result<Self> {
        fs::create_dir_all(session_dir)?;
        let path = session_dir.join("change_log.jsonl");
        // Touch the file
        OpenOptions::new().create(true).append(true).open(&path)?;
        Ok(Self { path })
    }

    /// Append an entry to the change log.
    pub fn append(&self, entry: &ChangeLogEntry) -> std::io::Result<()> {
        let mut file = OpenOptions::new().create(true).append(true).open(&self.path)?;
        let json = serde_json::to_string(entry).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::Other, e)
        })?;
        writeln!(file, "{}", json)?;
        Ok(())
    }

    /// Read all entries from the change log.
    pub fn read_all(&self) -> std::io::Result<Vec<ChangeLogEntry>> {
        let content = fs::read_to_string(&self.path)?;
        let mut entries = Vec::new();
        for line in content.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let entry: ChangeLogEntry = serde_json::from_str(line).map_err(|e| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, e)
            })?;
            entries.push(entry);
        }
        Ok(entries)
    }
}

/// Extract file path and operation from a tool call.
pub fn extract_file_info(
    tool_name: &str,
    tool_input: &serde_json::Value,
) -> (Option<String>, FileOperation) {
    match tool_name {
        "Write" => {
            let path = tool_input
                .get("file_path")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            (path, FileOperation::Create)
        }
        "Edit" => {
            let path = tool_input
                .get("file_path")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            (path, FileOperation::Modify)
        }
        "Read" => {
            let path = tool_input
                .get("file_path")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            (path, FileOperation::Read)
        }
        "Bash" => {
            let command = tool_input
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let path = parse_bash_file_path(command);
            let operation = classify_bash_operation(command);
            (path, operation)
        }
        _ => (None, FileOperation::Unknown),
    }
}

/// Best-effort extraction of file paths from bash commands.
/// Looks for common file-modifying patterns: rm, mv, cp, redirects, etc.
pub fn parse_bash_file_path(command: &str) -> Option<String> {
    let trimmed = command.trim();

    // Check for output redirects: command > file or command >> file
    if let Some(pos) = trimmed.rfind(">>") {
        let after = trimmed[pos + 2..].trim();
        let path = after.split_whitespace().next();
        if let Some(p) = path {
            return Some(p.trim_matches('"').trim_matches('\'').to_string());
        }
    }
    if let Some(pos) = trimmed.rfind('>') {
        // Make sure it's not inside quotes (rough check)
        let after = trimmed[pos + 1..].trim();
        let path = after.split_whitespace().next();
        if let Some(p) = path {
            return Some(p.trim_matches('"').trim_matches('\'').to_string());
        }
    }

    // Check for common file-modifying commands
    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    if parts.is_empty() {
        return None;
    }

    let cmd = parts[0];
    match cmd {
        "rm" | "mv" | "cp" | "touch" | "mkdir" | "chmod" | "chown" => {
            // Return the last argument as the target file
            parts.last().map(|s| s.trim_matches('"').trim_matches('\'').to_string())
        }
        "tee" => {
            // tee writes to stdout AND file(s)
            parts.get(1).map(|s| s.trim_matches('"').trim_matches('\'').to_string())
        }
        _ => None,
    }
}

/// Classify a bash command into the appropriate FileOperation.
/// Returns Delete for rm commands, Create for touch/mkdir, Modify for
/// cp/mv/tee/redirects, and Bash for everything else.
pub fn classify_bash_operation(command: &str) -> FileOperation {
    let trimmed = command.trim();

    // Check for output redirects — these modify/create files
    if trimmed.contains(">>") || trimmed.contains('>') {
        return FileOperation::Modify;
    }

    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    if parts.is_empty() {
        return FileOperation::Bash;
    }

    // Handle piped commands — classify based on the last command in the pipeline
    // e.g., "cat foo | tee bar" should classify based on "tee bar"
    let last_cmd = trimmed.rsplit('|').next().unwrap_or(trimmed).trim();
    let last_parts: Vec<&str> = last_cmd.split_whitespace().collect();
    let cmd = if !last_parts.is_empty() { last_parts[0] } else { parts[0] };

    match cmd {
        "rm" => FileOperation::Delete,
        "touch" | "mkdir" => FileOperation::Create,
        "mv" | "cp" | "chmod" | "chown" | "tee" | "sed" => FileOperation::Modify,
        _ => FileOperation::Bash,
    }
}

/// Create a ChangeLogEntry from a hook payload's extracted data.
pub fn create_entry(
    session_id: &str,
    tool_name: &str,
    tool_input: &serde_json::Value,
    tool_response: Option<&serde_json::Value>,
) -> ChangeLogEntry {
    let (file_path, operation) = extract_file_info(tool_name, tool_input);
    ChangeLogEntry {
        timestamp: Utc::now(),
        session_id: session_id.to_string(),
        tool_name: tool_name.to_string(),
        operation,
        file_path,
        tool_input: tool_input.clone(),
        tool_response: tool_response.cloned(),
    }
}
