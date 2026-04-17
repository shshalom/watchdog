use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const DEFAULT_PORT: u16 = 9100;
pub const DEFAULT_BATCH_INTERVAL: u64 = 15;
pub const DEFAULT_ESCALATION_THRESHOLD: usize = 3;
pub const DEFAULT_AUDITOR_MODEL: &str = "claude-sonnet-4-6";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchdogConfig {
    pub port: u16,
    pub batch_interval_seconds: u64,
    pub escalation_threshold: usize,
    pub project_dir: String,
    pub spec_path: Option<String>,  // Primary spec (first one) for backward compat
    #[serde(default)]
    pub spec_paths: Vec<String>,   // All spec files
    #[serde(default)]
    pub anthropic_api_key: Option<String>,
    #[serde(default = "default_model")]
    pub auditor_model: String,
    #[serde(default = "default_true")]
    pub auditor_enabled: bool,
    #[serde(default = "default_true")]
    pub enforcement_enabled: bool,
    #[serde(default = "default_audit_mode")]
    pub audit_mode: String,  // "strict", "balanced", "guided", "learning"
}

fn default_model() -> String { DEFAULT_AUDITOR_MODEL.to_string() }
fn default_true() -> bool { true }
fn default_audit_mode() -> String { "balanced".to_string() }

impl WatchdogConfig {
    pub fn new(project_dir: String, port: u16, spec_paths: Option<Vec<String>>) -> Self {
        let spec_path = spec_paths.as_ref().and_then(|p| p.first().cloned());
        // Try to load API key from environment, then config file
        let api_key = std::env::var("ANTHROPIC_API_KEY").ok()
            .or_else(|| load_from_config_file("anthropic_api_key"));

        let auditor_model = std::env::var("WATCHDOG_AUDITOR_MODEL").ok()
            .or_else(|| load_from_config_file("auditor_model"))
            .unwrap_or_else(|| DEFAULT_AUDITOR_MODEL.to_string());

        // If no spec was provided via CLI, restore from the last saved spec_paths
        let resolved_spec_paths = spec_paths.unwrap_or_else(|| {
            load_project_spec_paths(&project_dir).unwrap_or_default()
        });
        let spec_path = resolved_spec_paths.first().cloned().or(spec_path);

        Self {
            port,
            batch_interval_seconds: DEFAULT_BATCH_INTERVAL,
            escalation_threshold: DEFAULT_ESCALATION_THRESHOLD,
            project_dir,
            spec_path,
            spec_paths: resolved_spec_paths,
            anthropic_api_key: api_key,
            auditor_model,
            auditor_enabled: load_from_config_file("auditor_enabled")
                .map(|v| v != "false").unwrap_or(true),
            enforcement_enabled: load_from_config_file("enforcement_enabled")
                .map(|v| v != "false").unwrap_or(true),
            audit_mode: load_from_config_file("audit_mode")
                .unwrap_or_else(default_audit_mode),
        }
    }

    pub fn config_file_path() -> Option<PathBuf> {
        let home = std::env::var("HOME").ok()?;
        Some(PathBuf::from(home).join(".config").join("watchdog").join("config.yml"))
    }
}

/// Load a value from ~/.config/watchdog/config.yml
fn load_from_config_file(key: &str) -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let path = Path::new(&home).join(".config").join("watchdog").join("config.yml");
    let content = std::fs::read_to_string(&path).ok()?;
    // Simple key: value parsing (no YAML dependency needed)
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix(key) {
            let rest = rest.trim_start();
            if let Some(value) = rest.strip_prefix(':') {
                let value = value.trim().trim_matches('"').trim_matches('\'');
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

/// Save spec paths to {project_dir}/.watchdog/spec_paths (one path per line)
pub fn save_project_spec_paths(project_dir: &str, paths: &[String]) -> std::io::Result<()> {
    let dir = Path::new(project_dir).join(".watchdog");
    std::fs::create_dir_all(&dir)?;
    let content = paths.join("\n");
    std::fs::write(dir.join("spec_paths"), content)?;
    Ok(())
}

/// Load spec paths from {project_dir}/.watchdog/spec_paths
pub fn load_project_spec_paths(project_dir: &str) -> Option<Vec<String>> {
    let path = Path::new(project_dir).join(".watchdog").join("spec_paths");
    let content = std::fs::read_to_string(&path).ok()?;
    let paths: Vec<String> = content.lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    if paths.is_empty() { None } else { Some(paths) }
}

/// Save a value to ~/.config/watchdog/config.yml
pub fn save_to_config_file(key: &str, value: &str) -> std::io::Result<()> {
    let home = std::env::var("HOME").map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let dir = Path::new(&home).join(".config").join("watchdog");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("config.yml");

    let mut lines: Vec<String> = if path.exists() {
        std::fs::read_to_string(&path)?
            .lines()
            .map(|l| l.to_string())
            .collect()
    } else {
        vec![]
    };

    // Update or append
    let prefix = format!("{}:", key);
    let new_line = format!("{}: {}", key, value);
    let mut found = false;
    for line in &mut lines {
        if line.trim().starts_with(&prefix) {
            *line = new_line.clone();
            found = true;
            break;
        }
    }
    if !found {
        lines.push(new_line);
    }

    std::fs::write(&path, lines.join("\n") + "\n")?;
    Ok(())
}
