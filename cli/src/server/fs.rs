use axum::{
    extract::{Query, State},
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::lockwatch::LockWatchStore;
use crate::session::AppState;

// ---------------------------------------------------------------------------
// Browse
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub(crate) struct BrowseParams {
    path: Option<String>,
}

#[derive(Debug, Serialize)]
struct FsEntry {
    name: String,
    path: String,
    is_dir: bool,
    is_locked: bool,
    is_watched: bool,
}

/// Skipped in both browse and search — build artefacts and dependency caches.
const SKIP_NAMES: &[&str] = &[
    "node_modules", "target", ".git", "__pycache__", ".DS_Store",
    "dist", "build", ".next", ".nuxt", ".output", ".cache",
    "venv", ".venv", ".tox", ".eggs",
];

/// Additionally skipped during search — large macOS system/media dirs
/// that are irrelevant for code search and slow things down.
const SEARCH_SKIP_NAMES: &[&str] = &[
    "Library", "Applications", "Movies", "Music", "Pictures",
];

/// Skipped only when browsing from filesystem root — macOS internals never
/// useful in a file-locking context.
const ROOT_SKIP_NAMES: &[&str] = &[
    "System", "usr", "bin", "sbin", "cores", "dev", "proc",
];

fn should_skip(name: &str) -> bool {
    if name.starts_with('.') { return true; }
    SKIP_NAMES.contains(&name)
}

fn should_skip_at_root(name: &str) -> bool {
    should_skip(name) || ROOT_SKIP_NAMES.contains(&name)
}

fn should_skip_search(name: &str) -> bool {
    should_skip(name) || SEARCH_SKIP_NAMES.contains(&name)
}

/// GET /api/fs/browse?path=<dir>
pub(crate) async fn handle_fs_browse(
    State(state): State<AppState>,
    Query(params): Query<BrowseParams>,
) -> impl IntoResponse {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    let raw_path = params.path.as_deref().unwrap_or("").trim().to_string();
    let is_fs_root = raw_path == "/";
    let root = if raw_path.is_empty() || raw_path == "~" {
        home
    } else if raw_path.starts_with("~/") {
        let h = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
        format!("{}/{}", h, &raw_path[2..])
    } else {
        raw_path
    };

    let read_dir = match std::fs::read_dir(&root) {
        Ok(rd) => rd,
        Err(e) => {
            return Json(serde_json::json!({ "error": e.to_string() })).into_response();
        }
    };

    let store = {
        let inner = state.inner.read().await;
        let cloned = inner.lockwatch.lock().unwrap().clone();
        cloned
    };

    let mut dirs: Vec<FsEntry> = Vec::new();
    let mut files: Vec<FsEntry> = Vec::new();

    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_fs_root && should_skip_at_root(&name) {
            continue;
        } else if !is_fs_root && should_skip(&name) {
            continue;
        }

        let path = entry.path().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        let is_locked = store.is_locked(&path);
        let is_watched = store.is_watched(&path);

        let fs_entry = FsEntry {
            name,
            path,
            is_dir,
            is_locked,
            is_watched,
        };

        if is_dir {
            dirs.push(fs_entry);
        } else {
            files.push(fs_entry);
        }
    }

    // Sort each group alphabetically by name
    dirs.sort_by(|a, b| a.name.cmp(&b.name));
    files.sort_by(|a, b| a.name.cmp(&b.name));

    // Combine: directories first, then files
    dirs.extend(files);

    Json(serde_json::to_value(dirs).unwrap_or(serde_json::json!([]))).into_response()
}

// ---------------------------------------------------------------------------
// Locks state
// ---------------------------------------------------------------------------

/// GET /api/fs/locks
pub(crate) async fn handle_fs_locks(State(state): State<AppState>) -> impl IntoResponse {
    let store = {
        let inner = state.inner.read().await;
        let cloned = inner.lockwatch.lock().unwrap().clone();
        cloned
    };

    let locks: Vec<&str> = store.locks.iter().map(String::as_str).collect();
    let watches: Vec<&str> = store.watches.iter().map(String::as_str).collect();

    Json(serde_json::json!({
        "locks": locks,
        "watches": watches,
    }))
}

// ---------------------------------------------------------------------------
// Set lock / watch
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub(crate) struct LockBody {
    path: String,
    locked: bool,
}

/// POST /api/fs/lock
pub(crate) async fn handle_fs_set_lock(
    State(state): State<AppState>,
    Json(body): Json<LockBody>,
) -> impl IntoResponse {
    {
        let inner = state.inner.read().await;
        let mut store = inner.lockwatch.lock().unwrap();
        store.set_lock(&body.path, body.locked);
    }
    Json(serde_json::json!({ "ok": true }))
}

#[derive(Debug, Deserialize)]
pub(crate) struct WatchBody {
    path: String,
    watched: bool,
}

/// POST /api/fs/watch
pub(crate) async fn handle_fs_set_watch(
    State(state): State<AppState>,
    Json(body): Json<WatchBody>,
) -> impl IntoResponse {
    {
        let inner = state.inner.read().await;
        let mut store = inner.lockwatch.lock().unwrap();
        store.set_watch(&body.path, body.watched);
    }
    Json(serde_json::json!({ "ok": true }))
}

// ---------------------------------------------------------------------------
// Native file/folder picker (macOS osascript)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub(crate) struct PickParams {
    /// "file" | "folder" | "any"  (default: "any")
    kind: Option<String>,
    prompt: Option<String>,
    /// When true, allow picking multiple items. Returns `{ paths: [...] }`.
    multiple: Option<bool>,
}

/// GET /api/fs/pick — opens a native macOS file/folder picker.
/// With `multiple=true`, allows selecting multiple files and folders and returns
/// `{ paths: [...] }`. Without it, returns `{ path: "..." }`.
pub(crate) async fn handle_fs_pick(
    State(state): State<AppState>,
    Query(params): Query<PickParams>,
) -> impl IntoResponse {
    let kind = params.kind.as_deref().unwrap_or("any");
    let prompt = params
        .prompt
        .as_deref()
        .unwrap_or("Select a spec file or folder");
    let multiple = params.multiple.unwrap_or(false);

    let project_dir = {
        let inner = state.inner.read().await;
        inner.session.project_dir.clone()
    };

    let script = if multiple {
        // `choose file or folder` does NOT support `with multiple selections allowed`
        // (AppleScript syntax error). Use `choose file` which does support it.
        // Folder selection is handled separately via kind=folder.
        format!(
            r#"set theItems to choose file with prompt "{}" with multiple selections allowed
set pathList to {{}}
repeat with theItem in theItems
    set end of pathList to POSIX path of theItem
end repeat
set AppleScript's text item delimiters to "\n"
set output to pathList as string
set AppleScript's text item delimiters to ""
output"#,
            prompt
        )
    } else {
        // Single-select: use `default location` so the dialog opens at the project dir.
        match kind {
            "folder" => format!(
                r#"set p to (POSIX file "{}") as alias
POSIX path of (choose folder with prompt "{}" default location p)"#,
                project_dir, prompt
            ),
            _ => format!(
                r#"set p to (POSIX file "{}") as alias
POSIX path of (choose file with prompt "{}" default location p)"#,
                project_dir, prompt
            ),
        }
    };

    let result = tokio::task::spawn_blocking(move || {
        std::process::Command::new("osascript")
            .args(["-e", &script])
            .output()
    })
    .await;

    match result {
        Ok(Ok(output)) if output.status.success() => {
            if multiple {
                let paths: Vec<String> = String::from_utf8_lossy(&output.stdout)
                    .trim()
                    .split('\n')
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .collect();
                Json(serde_json::json!({ "paths": paths })).into_response()
            } else {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                Json(serde_json::json!({ "path": path })).into_response()
            }
        }
        // User cancelled — osascript exits 1
        Ok(Ok(_)) => Json(serde_json::json!({ "cancelled": true })).into_response(),
        _ => Json(serde_json::json!({ "error": "picker failed" })).into_response(),
    }
}

// ---------------------------------------------------------------------------
// Reveal in Finder
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub(crate) struct RevealBody {
    path: String,
}

/// POST /api/fs/reveal — opens the file/directory in macOS Finder (selects it).
pub(crate) async fn handle_fs_reveal(
    Json(body): Json<RevealBody>,
) -> impl IntoResponse {
    // `open -R` reveals and selects the item in Finder; works for files and dirs.
    let status = std::process::Command::new("open")
        .args(["-R", &body.path])
        .status();
    match status {
        Ok(s) if s.success() => Json(serde_json::json!({ "ok": true })),
        Ok(s) => Json(serde_json::json!({ "error": format!("open exited with {}", s) })),
        Err(e) => Json(serde_json::json!({ "error": e.to_string() })),
    }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub(crate) struct SearchParams {
    q: String,
    path: Option<String>,
}

/// GET /api/fs/search?q=<query>&path=<root>
/// Recursively searches from <root> (defaults to $HOME) for files whose name
/// contains <query> (case-insensitive). Returns up to 100 matches.
/// macOS system dirs (Library, Applications, Movies, Music, Pictures) are skipped.
pub(crate) async fn handle_fs_search(
    State(state): State<AppState>,
    Query(params): Query<SearchParams>,
) -> impl IntoResponse {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    let root = params
        .path
        .filter(|p| !p.is_empty() && p != "~")
        .map(|p| {
            if p.starts_with("~/") {
                format!("{}/{}", home, &p[2..])
            } else {
                p
            }
        })
        .unwrap_or_else(|| home.clone());

    let query = params.q.to_lowercase();
    if query.is_empty() {
        return Json(serde_json::json!([])).into_response();
    }

    let store = {
        let inner = state.inner.read().await;
        let cloned = inner.lockwatch.lock().unwrap().clone();
        cloned
    };

    // Run the recursive walk on a blocking thread so it doesn't stall the async executor
    let results = tokio::task::spawn_blocking(move || {
        let mut results: Vec<FsEntry> = Vec::new();
        search_recursive(&root, &query, &store, &mut results, 0);
        results.sort_by(|a, b| a.name.cmp(&b.name));
        results
    })
    .await
    .unwrap_or_default();

    Json(serde_json::to_value(results).unwrap_or(serde_json::json!([]))).into_response()
}

fn search_recursive(
    dir: &str,
    query: &str,
    store: &LockWatchStore,
    results: &mut Vec<FsEntry>,
    depth: u32,
) {
    if depth > 5 || results.len() >= 100 {
        return;
    }
    let Ok(read_dir) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read_dir.flatten() {
        if results.len() >= 100 {
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip_search(&name) {
            continue;
        }
        let path = entry.path().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        if !is_dir && name.to_lowercase().contains(query) {
            results.push(FsEntry {
                name,
                path: path.clone(),
                is_dir: false,
                is_locked: store.is_locked(&path),
                is_watched: store.is_watched(&path),
            });
        }
        if is_dir {
            search_recursive(&path, query, store, results, depth + 1);
        }
    }
}
