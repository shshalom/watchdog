mod hooks;
mod api;
mod audit;
mod dashboard;
mod discover;
mod fs;
mod status;
mod terminal;

use hooks::*;
use api::*;
use audit::*;
use dashboard::*;
use discover::*;
use fs::*;
use status::*;
use terminal::*;

use axum::{
    routing::{get, post},
    Router,
};
use std::net::SocketAddr;
use tokio::net::TcpListener;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

use crate::session::AppState;

/// Build the axum router with all endpoints.
pub fn build_router(state: AppState) -> Router {
    Router::new()
        // Hook endpoints (called by Claude Code)
        .route("/hook/pre-tool-use", post(handle_pre_tool_use))
        .route("/hook/post-tool-use", post(handle_post_tool_use))
        // REST API endpoints (called by dashboard / CLI)
        .route("/api/config", get(handle_get_config))
        .route("/api/config/update", post(handle_update_config))
        .route("/api/sessions", get(handle_get_sessions))
        .route("/api/sessions/{id}", get(handle_get_session))
        .route("/api/sessions/{id}/files", get(handle_get_session_files))
        .route("/api/sessions/{id}/spec", get(handle_get_spec))
        .route("/api/sessions/{id}/diff/{*path}", get(handle_get_file_diff))
        // Per-session config
        .route("/api/sessions/{id}/config", post(handle_update_session_config))
        // Audit trail
        .route("/api/sessions/{id}/audit-trail", get(handle_get_audit_trail))
        .route("/api/audit-trail/dismiss", post(handle_dismiss_audit_entries))
        // Issue threads
        .route("/api/sessions/{id}/issues", get(handle_get_issues))
        // Status endpoint (used by `watchdog status` CLI)
        .route("/api/status", get(handle_get_status))
        // Session observation registration
        .route("/api/observe/register", post(handle_register_session))
        .route("/api/observe/unregister", post(handle_unregister_session))
        // Spec management
        .route("/api/reload-specs", post(handle_reload_specs))
        // Project & session discovery (for web dashboard)
        .route("/api/project", get(handle_get_project))
        .route("/api/project/sessions", get(handle_discover_sessions))
        .route("/api/project/sessions/{id}/label", post(handle_set_session_label))
        // Filesystem browse + lock/watch + search
        .route("/api/fs/browse", get(handle_fs_browse))
        .route("/api/fs/locks", get(handle_fs_locks))
        .route("/api/fs/lock", post(handle_fs_set_lock))
        .route("/api/fs/watch", post(handle_fs_set_watch))
        .route("/api/fs/search", get(handle_fs_search))
        .route("/api/fs/reveal", post(handle_fs_reveal))
        .route("/api/fs/pick", get(handle_fs_pick))
        // Handoff lifecycle
        .route("/api/handoff", get(handle_get_handoff))
        .route("/api/handoff/mark-used", post(handle_mark_handoff_used))
        // Terminal PTY endpoints
        .route("/api/terminal/start", post(handle_terminal_start))
        .route("/api/terminal/ws/{id}", get(handle_terminal_ws))
        // WebSocket endpoint
        .route("/api/ws/events", get(handle_ws_upgrade))
        .with_state(state)
        // Serve embedded web dashboard for all other routes (SPA fallback)
        .fallback(get(handle_dashboard))
        // CORS for development (Vite dev server on :3000)
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
}

/// Start the HTTP server.
pub async fn start_server(state: AppState, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let app = build_router(state);
    // Bind to 127.0.0.1 (IPv4 loopback) — reliable for both API and WebSocket clients
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await?;
    let addr = listener.local_addr()?;
    info!("Watchdog server listening on http://{}", addr);
    eprintln!(
        "\x1b[1;32m[watchdog]\x1b[0m Server listening on http://localhost:{}",
        port
    );
    eprintln!(
        "\x1b[1;32m[watchdog]\x1b[0m Dashboard: http://localhost:{}/",
        port
    );
    eprintln!("\x1b[1;32m[watchdog]\x1b[0m Waiting for agent activity...\n");

    axum::serve(listener, app).await?;
    Ok(())
}
