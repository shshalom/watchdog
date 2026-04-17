use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use tracing::{info, warn};

/// Register watchdog HTTP hooks in `.claude/settings.local.json`.
pub fn register_hooks(project_dir: &Path, port: u16) -> std::io::Result<()> {
    let settings_path = get_settings_path(project_dir);
    let mut settings = read_settings(&settings_path)?;

    let hooks = build_hooks_config(port);
    settings["hooks"] = hooks;

    write_settings(&settings_path, &settings)?;
    info!(
        "Registered hooks in {}",
        settings_path.display()
    );
    Ok(())
}

/// Remove watchdog HTTP hooks from `.claude/settings.local.json`.
/// NOTE: We intentionally leave hooks in place so active Claude Code sessions
/// continue to send events. The next server start will update the port.
/// Only truly remove hooks when the dashboard app quits entirely.
pub fn remove_hooks(project_dir: &Path) -> std::io::Result<()> {
    // Don't remove hooks — they need to persist for active Claude Code sessions.
    // The hooks will be updated with the correct port on next server start.
    let settings_path = get_settings_path(project_dir);
    if settings_path.exists() {
        info!("Hooks preserved in {} (will be updated on next server start)", settings_path.display());
    } else {
        info!("No settings file found, nothing to remove");
    }
    Ok(())
}

/// Force-remove hooks — only called on app quit, not on server stop.
pub fn force_remove_hooks(project_dir: &Path) -> std::io::Result<()> {
    let settings_path = get_settings_path(project_dir);
    if !settings_path.exists() {
        return Ok(());
    }

    let mut settings = read_settings(&settings_path)?;

    if let Some(obj) = settings.as_object_mut() {
        obj.remove("hooks");
    }

    if settings.as_object().map_or(true, |o| o.is_empty()) {
        fs::remove_file(&settings_path)?;
        info!("Removed settings file {}", settings_path.display());
    } else {
        write_settings(&settings_path, &settings)?;
        info!("Removed hooks from {}", settings_path.display());
    }
    Ok(())
}

fn get_settings_path(project_dir: &Path) -> PathBuf {
    project_dir.join(".claude").join("settings.local.json")
}

fn read_settings(path: &Path) -> std::io::Result<Value> {
    if path.exists() {
        let content = fs::read_to_string(path)?;
        serde_json::from_str(&content).map_err(|e| {
            warn!("Failed to parse existing settings: {}", e);
            std::io::Error::new(std::io::ErrorKind::InvalidData, e)
        })
    } else {
        Ok(serde_json::json!({}))
    }
}

fn write_settings(path: &Path, settings: &Value) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let content = serde_json::to_string_pretty(settings).map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::Other, e)
    })?;
    fs::write(path, content)?;
    Ok(())
}

fn build_hooks_config(port: u16) -> Value {
    serde_json::json!({
        "PostToolUse": [
            {
                "hooks": [
                    {
                        "type": "http",
                        "url": format!("http://localhost:{}/hook/post-tool-use", port),
                        "timeout": 5
                    }
                ]
            }
        ],
        "PreToolUse": [
            {
                "hooks": [
                    {
                        "type": "http",
                        "url": format!("http://localhost:{}/hook/pre-tool-use", port),
                        "timeout": 5
                    }
                ]
            }
        ]
    })
}
