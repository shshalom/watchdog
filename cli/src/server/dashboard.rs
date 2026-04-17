use axum::{
    body::Body,
    http::{header, Request, Response, StatusCode},
    response::IntoResponse,
};
use rust_embed::Embed;

/// Embedded web dashboard assets (built from dashboard-web/dist/).
/// When building for release, run `npm run build` in dashboard-web/ first,
/// then `cargo build --release` to embed the output.
#[derive(Embed)]
#[folder = "../dashboard-web/dist/"]
struct DashboardAssets;

/// Serve embedded dashboard assets. Falls back to index.html for SPA routing.
pub async fn handle_dashboard(req: Request<Body>) -> impl IntoResponse {
    let path = req.uri().path().trim_start_matches('/');

    // Try the exact path first
    if let Some(content) = DashboardAssets::get(path) {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime.as_ref())
            .header(header::CACHE_CONTROL, cache_control(path))
            .body(Body::from(content.data.to_vec()))
            .unwrap();
    }

    // SPA fallback: serve index.html for any non-file path
    if let Some(index) = DashboardAssets::get("index.html") {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html")
            .header(header::CACHE_CONTROL, "no-cache")
            .body(Body::from(index.data.to_vec()))
            .unwrap();
    }

    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(Body::from("Dashboard not found. Build with: cd dashboard-web && npm run build"))
        .unwrap()
}

/// Cache hashed assets aggressively, everything else no-cache.
fn cache_control(path: &str) -> &'static str {
    if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    }
}
