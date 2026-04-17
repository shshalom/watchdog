//! Terminal session management.
//!
//! POST /api/terminal/start  — spawn `claude` in a PTY, return terminal_id.
//! GET  /api/terminal/ws/:id — bidirectional WebSocket: binary = PTY bytes,
//!                             text JSON = control (resize).

use axum::{
    extract::{Path, State, WebSocketUpgrade},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use axum::extract::ws::{Message, WebSocket};
use portable_pty::{CommandBuilder, PtyPair, PtySize, native_pty_system};
use serde::Deserialize;
use std::io::{Read, Write};
use std::sync::Arc;
use tokio::sync::broadcast;
use tracing::{info, warn};
use uuid::Uuid;

use crate::session::{AppState, TerminalCommand, TerminalSession};

// ── Request body ──────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub(crate) struct StartTerminalRequest {
    pub session_id: Option<String>,
    pub working_dir: String,
    pub mode: String, // "resume" | "new"
}

// ── POST /api/terminal/start ──────────────────────────────────────────

pub(crate) async fn handle_terminal_start(
    State(state): State<AppState>,
    Json(body): Json<StartTerminalRequest>,
) -> impl IntoResponse {
    let terminal_id = Uuid::new_v4().to_string();
    let working_dir = body.working_dir.clone();

    // Build the claude command
    let mut cmd = CommandBuilder::new("claude");
    if body.mode == "resume" {
        if let Some(ref sid) = body.session_id {
            cmd.arg("--resume");
            cmd.arg(sid);
        }
    }
    cmd.arg("--dangerously-skip-permissions");
    cmd.cwd(&working_dir);

    // Open PTY
    let pty_system = native_pty_system();
    let pair = match pty_system.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(p) => p,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("PTY open failed: {e}") })),
            ).into_response();
        }
    };

    let PtyPair { master, slave } = pair;

    // Spawn the child process using the slave PTY
    let mut child = match slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("Spawn failed: {e}") })),
            ).into_response();
        }
    };
    drop(slave); // Close slave in parent so we get EOF when child exits

    // Clone reader from master before consuming the writer
    let reader = match master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("PTY reader failed: {e}") })),
            ).into_response();
        }
    };
    let writer = match master.take_writer() {
        Ok(w) => w,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("PTY writer failed: {e}") })),
            ).into_response();
        }
    };
    // Keep master alive for resize calls
    let master_arc = Arc::new(std::sync::Mutex::new(master));

    // Channels
    let (output_tx, _) = broadcast::channel::<Vec<u8>>(512);
    let (input_tx, input_rx) = tokio::sync::mpsc::unbounded_channel::<TerminalCommand>();

    // ── Reader task: PTY output → broadcast channel ───────────────────
    {
        let output_tx = output_tx.clone();
        let event_tx = state.event_tx.clone();
        let tid = terminal_id.clone();
        let terminal_store = Arc::clone(&state.terminal_store);

        tokio::task::spawn_blocking(move || {
            let mut reader = reader;
            let mut buf = vec![0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let _ = output_tx.send(buf[..n].to_vec());
                    }
                }
            }
            info!("Terminal {} PTY closed", tid);

            // Notify dashboard clients the process exited
            let event = serde_json::json!({
                "type": "terminal_exited",
                "terminal_id": tid,
            });
            let _ = event_tx.send(event.to_string());

            // Clean up session from store
            let rt = tokio::runtime::Handle::current();
            rt.block_on(async move {
                terminal_store.lock().await.remove(&tid);
            });
        });
    }

    // ── Child waiter: reap the process to avoid zombies ───────────────
    tokio::task::spawn_blocking(move || {
        let _ = child.wait();
    });

    // ── Writer task: input channel → PTY stdin / resize ───────────────
    {
        let master_arc = Arc::clone(&master_arc);
        let rt = tokio::runtime::Handle::current();
        tokio::task::spawn_blocking(move || {
            let mut writer = writer;
            let mut rx = input_rx;
            loop {
                match rt.block_on(rx.recv()) {
                    Some(TerminalCommand::Input(bytes)) => {
                        let _ = writer.write_all(&bytes);
                    }
                    Some(TerminalCommand::Resize(cols, rows)) => {
                        if let Ok(ref m) = master_arc.lock() {
                            let _ = m.resize(PtySize {
                                rows,
                                cols,
                                pixel_width: 0,
                                pixel_height: 0,
                            });
                        }
                    }
                    None => break,
                }
            }
        });
    }

    // Register in store
    state.terminal_store.lock().await.insert(
        terminal_id.clone(),
        TerminalSession {
            output_tx,
            input_tx,
            working_dir,
        },
    );

    info!("Terminal {} started (mode={})", terminal_id, body.mode);
    Json(serde_json::json!({ "terminal_id": terminal_id })).into_response()
}

// ── GET /api/terminal/ws/:id ──────────────────────────────────────────

pub(crate) async fn handle_terminal_ws(
    State(state): State<AppState>,
    Path(terminal_id): Path<String>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| async move {
        handle_terminal_ws_conn(socket, state, terminal_id).await;
    })
}

async fn handle_terminal_ws_conn(mut socket: WebSocket, state: AppState, terminal_id: String) {
    let (mut output_rx, input_tx) = {
        let store = state.terminal_store.lock().await;
        match store.get(&terminal_id) {
            Some(s) => (s.output_tx.subscribe(), s.input_tx.clone()),
            None => {
                info!("Terminal WS: {} not found", terminal_id);
                return;
            }
        }
    };

    info!("Terminal {} WebSocket connected", terminal_id);

    loop {
        tokio::select! {
            // PTY output → WebSocket client (binary frame)
            result = output_rx.recv() => {
                match result {
                    Ok(bytes) => {
                        if socket.send(Message::Binary(bytes.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        warn!("Terminal {} WS lagged, dropped {} chunks", terminal_id, n);
                    }
                    Err(_) => break, // PTY closed
                }
            }
            // WebSocket input → PTY
            msg = socket.recv() => {
                match msg {
                    // Binary frame = raw stdin bytes (keystrokes)
                    Some(Ok(Message::Binary(bytes))) => {
                        let _ = input_tx.send(TerminalCommand::Input(bytes.to_vec()));
                    }
                    // Text frame = JSON control message (resize only for now)
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                            if val.get("type").and_then(|t| t.as_str()) == Some("resize") {
                                let cols = val.get("cols").and_then(|c| c.as_u64()).unwrap_or(80) as u16;
                                let rows = val.get("rows").and_then(|r| r.as_u64()).unwrap_or(24) as u16;
                                let _ = input_tx.send(TerminalCommand::Resize(cols, rows));
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }

    info!("Terminal {} WebSocket disconnected", terminal_id);
}
