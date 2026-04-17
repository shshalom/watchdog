mod auditor;
mod changelog;
mod rules;
mod config;
mod hooks;
mod imports;
mod lockwatch;
mod models;
mod server;
mod session;
mod transcript;

use clap::{Parser, Subcommand};
use config::WatchdogConfig;
use models::SessionStatus;
use std::path::PathBuf;
use tracing::info;

#[derive(Parser)]
#[command(name = "watchdog", about = "Agent Watchdog — live spec-governance for coding agents")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Start the watchdog server and begin monitoring
    Start {
        /// Path to spec file(s) — can be specified multiple times
        #[arg(long)]
        spec: Vec<String>,

        /// Port to listen on
        #[arg(long, default_value_t = config::DEFAULT_PORT)]
        port: u16,

        /// Project directory (defaults to current directory)
        #[arg(long)]
        project_dir: Option<String>,

        /// Parent process ID — watchdog self-terminates when this PID dies
        #[arg(long)]
        parent_pid: Option<i32>,
    },

    /// Stop the watchdog server and remove hooks
    Stop {
        /// Project directory (defaults to current directory)
        #[arg(long)]
        project_dir: Option<String>,
    },

    /// Show the status of the current watchdog session
    Status {
        /// Project directory (defaults to current directory)
        #[arg(long)]
        project_dir: Option<String>,
    },

    /// List all sessions
    Sessions {
        /// Project directory (defaults to current directory)
        #[arg(long)]
        project_dir: Option<String>,
    },

    /// Interactive setup: register hooks, create .watchdog/, validate API key
    Init {
        /// Project directory (defaults to current directory)
        #[arg(long)]
        project_dir: Option<String>,

        /// Skip prompts (use defaults, no interactive API-key input)
        #[arg(long)]
        non_interactive: bool,
    },
}

#[tokio::main]
async fn main() {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("watchdog=info")),
        )
        .with_target(false)
        .init();

    let cli = Cli::parse();

    match cli.command {
        Commands::Start {
            spec,
            port,
            project_dir,
            parent_pid,
        } => {
            if let Err(e) = cmd_start(spec, port, project_dir, parent_pid).await {
                eprintln!("\x1b[1;31m[watchdog] Error:\x1b[0m {}", e);
                std::process::exit(1);
            }
        }
        Commands::Stop { project_dir } => {
            if let Err(e) = cmd_stop(project_dir) {
                eprintln!("\x1b[1;31m[watchdog] Error:\x1b[0m {}", e);
                std::process::exit(1);
            }
        }
        Commands::Status { project_dir } => {
            cmd_status(project_dir);
        }
        Commands::Sessions { project_dir } => {
            cmd_sessions(project_dir);
        }
        Commands::Init { project_dir, non_interactive } => {
            if let Err(e) = cmd_init(project_dir, non_interactive) {
                eprintln!("\x1b[1;31m[watchdog] Error:\x1b[0m {}", e);
                std::process::exit(1);
            }
        }
    }
}

fn cmd_init(
    project_dir: Option<String>,
    non_interactive: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    use std::io::{self, Write};

    let project_dir = resolve_project_dir(project_dir)?;
    let project_dir_str = project_dir.to_string_lossy().to_string();

    println!("\x1b[1;36m┌─ Watchdog init\x1b[0m");
    println!("\x1b[1;36m│\x1b[0m Project: {}", project_dir_str);
    println!("\x1b[1;36m│\x1b[0m");

    // 1. Create .watchdog directory
    std::fs::create_dir_all(project_dir.join(".watchdog"))?;
    println!("\x1b[1;32m│\x1b[0m ✓ Created .watchdog/ directory");

    // 2. Register Claude Code hooks
    hooks::register_hooks(&project_dir, config::DEFAULT_PORT)?;
    println!(
        "\x1b[1;32m│\x1b[0m ✓ Registered hooks in .claude/settings.local.json (port {})",
        config::DEFAULT_PORT
    );

    // 3. Check for API key
    let has_env_key = std::env::var("ANTHROPIC_API_KEY")
        .ok()
        .filter(|s| !s.is_empty())
        .is_some();

    if has_env_key {
        println!("\x1b[1;32m│\x1b[0m ✓ Anthropic API key found (ANTHROPIC_API_KEY)");
    } else if !non_interactive {
        print!("\x1b[1;36m│\x1b[0m Anthropic API key (enter to skip — auditor disabled without it): ");
        io::stdout().flush().ok();
        let mut key = String::new();
        io::stdin().read_line(&mut key).ok();
        let key = key.trim().to_string();
        if !key.is_empty() {
            config::save_to_config_file("anthropic_api_key", &key)?;
            println!("\x1b[1;32m│\x1b[0m ✓ Saved API key to ~/.config/watchdog/config.yml");
        } else {
            println!("\x1b[1;33m│\x1b[0m ⚠ No API key — LLM auditor disabled (deterministic rules still work)");
        }
    } else {
        println!("\x1b[1;33m│\x1b[0m ⚠ No API key — LLM auditor disabled (deterministic rules still work)");
    }

    // 4. Check for spec
    if crate::config::load_project_spec_paths(&project_dir_str).is_some() {
        println!("\x1b[1;32m│\x1b[0m ✓ Spec paths persisted in .watchdog/spec_paths");
    } else {
        println!(
            "\x1b[1;33m│\x1b[0m ⚠ No spec linked yet — link one from the dashboard, or pass --spec"
        );
    }

    println!("\x1b[1;36m│\x1b[0m");
    println!("\x1b[1;36m└─ Ready\x1b[0m");
    println!();
    println!("Next: \x1b[1mwatchdog start\x1b[0m");
    println!(
        "Dashboard: \x1b[1;34mhttp://localhost:{}\x1b[0m",
        config::DEFAULT_PORT
    );
    Ok(())
}

async fn cmd_start(
    specs: Vec<String>,
    port: u16,
    project_dir: Option<String>,
    parent_pid: Option<i32>,
) -> Result<(), Box<dyn std::error::Error>> {
    let project_dir = resolve_project_dir(project_dir)?;
    let project_dir_str = project_dir.to_string_lossy().to_string();

    // Check if already running
    if let Some((pid, existing_port)) = session::read_pid_file(&project_dir) {
        // Check if process is actually alive
        if is_process_alive(pid) {
            eprintln!(
                "\x1b[1;33m[watchdog]\x1b[0m Already running (pid={}, port={})",
                pid, existing_port
            );
            return Ok(());
        }
        // Stale PID file, clean up
        session::remove_pid_file(&project_dir);
    }

    let spec_paths = if specs.is_empty() { None } else { Some(specs.clone()) };
    let config = WatchdogConfig::new(project_dir_str.clone(), port, spec_paths);

    // Generate a session ID and create session directory
    let session_id = uuid::Uuid::new_v4().to_string();
    let sess_dir = session::session_dir(&project_dir, &session_id);

    eprintln!("\x1b[1;32m[watchdog]\x1b[0m Starting Agent Watchdog");
    eprintln!("  Project: {}", project_dir_str);
    for s in &specs {
        eprintln!("  Spec:    {}", s);
    }
    eprintln!("  Port:    {}", port);
    eprintln!("  Session: {}", session_id);
    eprintln!();

    // Create app state
    let state = session::AppState::new(config, &sess_dir)?;

    // Register hooks in .claude/settings.local.json
    hooks::register_hooks(&project_dir, port)?;
    eprintln!("\x1b[1;32m[watchdog]\x1b[0m Hooks registered in .claude/settings.local.json");

    // Write PID file
    session::write_pid_file(&project_dir, port)?;

    // Set up Ctrl+C handler
    let shutdown_project_dir = project_dir.clone();
    tokio::spawn(async move {
        tokio::signal::ctrl_c()
            .await
            .expect("Failed to listen for ctrl_c");
        eprintln!("\n\x1b[1;33m[watchdog]\x1b[0m Shutting down...");

        // Clean up hooks and PID file
        let _ = hooks::remove_hooks(&shutdown_project_dir);
        session::remove_pid_file(&shutdown_project_dir);

        eprintln!("\x1b[1;32m[watchdog]\x1b[0m Stopped. Hooks removed.");
        std::process::exit(0);
    });

    // Start parent PID monitor if requested (self-terminate when parent dies)
    if let Some(ppid) = parent_pid {
        let monitor_project_dir = project_dir.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                if !is_pid_alive(ppid) {
                    eprintln!("\n\x1b[1;33m[watchdog]\x1b[0m Parent process (pid={}) exited. Shutting down...", ppid);
                    let _ = hooks::remove_hooks(&monitor_project_dir);
                    session::remove_pid_file(&monitor_project_dir);
                    eprintln!("\x1b[1;32m[watchdog]\x1b[0m Stopped. Hooks removed.");
                    std::process::exit(0);
                }
            }
        });
        eprintln!("\x1b[1;32m[watchdog]\x1b[0m Monitoring parent process (pid={})", ppid);
    }

    // Start the auditor loop in the background
    let auditor_state = state.clone();
    tokio::spawn(async move {
        auditor::run_auditor_loop(auditor_state).await;
    });

    // Start the HTTP server (blocks until shutdown)
    server::start_server(state, port).await?;

    Ok(())
}

fn cmd_stop(project_dir: Option<String>) -> Result<(), Box<dyn std::error::Error>> {
    let project_dir = resolve_project_dir(project_dir)?;

    // Read PID file
    match session::read_pid_file(&project_dir) {
        Some((pid, port)) => {
            eprintln!(
                "\x1b[1;32m[watchdog]\x1b[0m Stopping watchdog (pid={}, port={})",
                pid, port
            );

            // Remove hooks
            hooks::remove_hooks(&project_dir)?;
            eprintln!("\x1b[1;32m[watchdog]\x1b[0m Hooks removed from .claude/settings.local.json");

            // Kill the process
            if is_process_alive(pid) {
                unsafe {
                    libc_kill(pid);
                }
                eprintln!("\x1b[1;32m[watchdog]\x1b[0m Server process terminated");
            }

            // Remove PID file
            session::remove_pid_file(&project_dir);

            eprintln!("\x1b[1;32m[watchdog]\x1b[0m Stopped.");
        }
        None => {
            // No PID file, but still try to clean up hooks
            hooks::remove_hooks(&project_dir)?;
            eprintln!("\x1b[1;33m[watchdog]\x1b[0m No running watchdog found. Cleaned up hooks if present.");
        }
    }

    Ok(())
}

fn cmd_status(project_dir: Option<String>) {
    let project_dir = match resolve_project_dir(project_dir) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("\x1b[1;31m[watchdog] Error:\x1b[0m {}", e);
            return;
        }
    };

    match session::read_pid_file(&project_dir) {
        Some((pid, port)) => {
            let alive = is_process_alive(pid);
            if !alive {
                eprintln!("\x1b[1;33m[watchdog]\x1b[0m Status: STALE (process not running)");
                eprintln!("  Run `watchdog stop` to clean up.");
                return;
            }

            // Try to get rich status from the running server (sync HTTP to avoid runtime-in-runtime panic)
            match fetch_rich_status_sync(port) {
                Some(status) => print_rich_status(&status),
                None => {
                    // Fallback to basic PID info
                    eprintln!("\x1b[1;32m[watchdog]\x1b[0m Status: RUNNING");
                    eprintln!("  PID:  {}", pid);
                    eprintln!("  Port: {}", port);
                    eprintln!(
                        "  API:  http://127.0.0.1:{}/api/sessions",
                        port
                    );
                }
            }
        }
        None => {
            eprintln!("Agent Watchdog — No active session");
            eprintln!("  Run `watchdog start --spec <file>` to begin.");
        }
    }
}

fn fetch_rich_status_sync(port: u16) -> Option<serde_json::Value> {
    let url = format!("http://127.0.0.1:{}/api/status", port);
    let agent = ureq::Agent::new_with_config(
        ureq::config::Config::builder()
            .timeout_global(Some(std::time::Duration::from_secs(3)))
            .build()
    );
    let resp = agent.get(&url).call().ok()?;
    if resp.status() != 200 { return None; }
    resp.into_body().read_json().ok()
}

fn print_rich_status(status: &serde_json::Value) {
    let session = &status["session"];
    let enforcement = &status["enforcement"];
    let files = &status["files"];
    let auditor = &status["auditor"];
    let drift_events = status["drift_events"].as_array();
    let escalation = &status["escalation"];
    let specs = &status["specs"];

    let session_id = session["id"].as_str().unwrap_or("unknown");
    let project_dir = session["project_dir"].as_str().unwrap_or("unknown");
    let session_status = session["status"].as_str().unwrap_or("unknown");
    let elapsed_secs = session["elapsed_seconds"].as_i64().unwrap_or(0);

    // Format uptime
    let hours = elapsed_secs / 3600;
    let minutes = (elapsed_secs % 3600) / 60;
    let uptime = if hours > 0 {
        format!("{}h {}m", hours, minutes)
    } else {
        format!("{}m", minutes)
    };

    let enforcement_enabled = enforcement["enabled"].as_bool().unwrap_or(false);
    let mode = enforcement["mode"].as_str().unwrap_or("balanced");
    let enforcement_str = if enforcement_enabled {
        format!("ON ({})", mode)
    } else {
        "OFF".to_string()
    };

    let tracked = files["tracked"].as_u64().unwrap_or(0);
    let pending = files["pending_audit"].as_u64().unwrap_or(0);

    let auditor_enabled = auditor["enabled"].as_bool().unwrap_or(false);
    let auditor_model = auditor["model"].as_str().unwrap_or("unknown");
    let cycles = auditor["cycles_completed"].as_u64().unwrap_or(0);
    let next_in = auditor["next_audit_in_seconds"].as_u64().unwrap_or(0);

    let esc_count = escalation["count"].as_u64().unwrap_or(0);
    let esc_threshold = escalation["threshold"].as_u64().unwrap_or(3);

    let spec_count = specs["count"].as_u64().unwrap_or(0);

    eprintln!("Agent Watchdog — Status");
    eprintln!("  Session:      {}", session_id);
    eprintln!("  Project:      {}", project_dir);
    eprintln!("  Status:       {}", session_status);
    eprintln!("  Enforcement:  {}", enforcement_str);
    eprintln!("  Uptime:       {}", uptime);
    eprintln!("  Files:        {} tracked, {} pending audit", tracked, pending);
    eprintln!("  Audit:        {} cycles completed, next in {}s", cycles, next_in);
    eprintln!();

    if let Some(events) = drift_events {
        if events.is_empty() {
            eprintln!("  No active drift events.");
        } else {
            eprintln!("  Active Drift Events:");
            for (i, event) in events.iter().enumerate() {
                let file_path = event["file_path"].as_str().unwrap_or("unknown");
                let finding = event["finding"].as_str().unwrap_or("drift");
                let rule_type = event["rule_type"].as_str().unwrap_or("unknown");
                let state = event["state"].as_str().unwrap_or("unknown");
                let reason = event["reason"].as_str().unwrap_or("");
                let attempts = event["correction_attempts"].as_u64().unwrap_or(0);

                // Calculate time since detection
                let since = event["detected_at"].as_str()
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .map(|dt| {
                        let diff = chrono::Utc::now().signed_duration_since(dt);
                        let mins = diff.num_minutes();
                        if mins < 1 { "<1m ago".to_string() }
                        else if mins < 60 { format!("{}m ago", mins) }
                        else { format!("{}h {}m ago", mins / 60, mins % 60) }
                    })
                    .unwrap_or_else(|| "unknown".to_string());

                eprintln!("    [{}] {}", i + 1, file_path);
                eprintln!("        Finding:  {} ({})", finding, rule_type);
                eprintln!("        State:    {}", state);
                eprintln!("        Reason:   {}", reason);
                eprintln!("        Attempts: {} / {} (escalation threshold)", attempts, esc_threshold);
                eprintln!("        Since:    {}", since);
                eprintln!();
            }
        }
    } else {
        eprintln!("  No active drift events.");
    }

    eprintln!("  Escalation:   {} / {} (threshold)", esc_count, esc_threshold);
    eprintln!("  Auditor:      {} ({})", auditor_model,
        if auditor_enabled { "enabled" } else { "disabled" });
    eprintln!("  Specs:        {} files locked", spec_count);
}

fn cmd_sessions(project_dir: Option<String>) {
    let project_dir = match resolve_project_dir(project_dir) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("\x1b[1;31m[watchdog] Error:\x1b[0m {}", e);
            return;
        }
    };

    let sessions_dir = project_dir.join(".watchdog").join("sessions");
    if !sessions_dir.exists() {
        eprintln!("\x1b[1;33m[watchdog]\x1b[0m No sessions found.");
        return;
    }

    let entries = match std::fs::read_dir(&sessions_dir) {
        Ok(e) => e,
        Err(_) => {
            eprintln!("\x1b[1;33m[watchdog]\x1b[0m No sessions found.");
            return;
        }
    };

    eprintln!("\x1b[1;32m[watchdog]\x1b[0m Sessions:\n");
    let mut count = 0;
    for entry in entries.flatten() {
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            let name = entry.file_name().to_string_lossy().to_string();
            let change_log_path = entry.path().join("change_log.jsonl");
            let event_count = if change_log_path.exists() {
                std::fs::read_to_string(&change_log_path)
                    .map(|c| c.lines().filter(|l| !l.trim().is_empty()).count())
                    .unwrap_or(0)
            } else {
                0
            };
            eprintln!("  {} ({} events)", name, event_count);
            count += 1;
        }
    }

    if count == 0 {
        eprintln!("  (none)");
    }
}

fn resolve_project_dir(dir: Option<String>) -> Result<PathBuf, Box<dyn std::error::Error>> {
    match dir {
        Some(d) => {
            let p = PathBuf::from(d);
            if !p.exists() {
                return Err(format!("Directory does not exist: {}", p.display()).into());
            }
            Ok(p.canonicalize()?)
        }
        None => Ok(std::env::current_dir()?),
    }
}

fn is_pid_alive(pid: i32) -> bool {
    unsafe { kill(pid, 0) == 0 }
}

fn is_process_alive(pid: u32) -> bool {
    // Use kill(pid, 0) to check if process exists
    // This is a POSIX-standard way to check without sending a real signal
    unsafe {
        let result = libc_kill_check(pid);
        result == 0
    }
}

// Minimal libc wrappers to avoid adding a full libc dependency
extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

unsafe fn libc_kill_check(pid: u32) -> i32 {
    unsafe { kill(pid as i32, 0) }
}

unsafe fn libc_kill(pid: u32) {
    unsafe { kill(pid as i32, 15); } // SIGTERM
}
