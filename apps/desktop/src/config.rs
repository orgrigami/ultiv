//! Where the app finds its server and remembers its session: `~/.spriessen/
//! desktop-session` (0600, one JSON line), `SPRIESSEN_URL` overriding the
//! default `http://127.0.0.1:8787`.

use crate::net::api::Auth;
use std::path::PathBuf;

/// The server to talk to: `SPRIESSEN_URL`, else the loopback default.
pub fn server_url() -> String {
    let url = std::env::var("SPRIESSEN_URL").unwrap_or_default();
    if url.is_empty() {
        "http://127.0.0.1:8787".into()
    } else {
        url.trim_end_matches('/').to_string()
    }
}

/// The saved session file, created on demand (0700 dir, 0600 file).
fn session_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let dir = PathBuf::from(home).join(".spriessen");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("desktop-session"))
}

/// Load the remembered cookie, if one is still on disk.
pub fn load_cookie() -> Option<String> {
    let text = std::fs::read_to_string(session_path()?).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("cookie").and_then(serde_json::Value::as_str).map(String::from)
}

/// Remember the cookie for next launch (or forget it when None).
pub fn save_cookie(cookie: Option<&str>) {
    let Some(path) = session_path() else { return };
    let body = match cookie {
        Some(c) => serde_json::json!({ "cookie": c }).to_string(),
        None => serde_json::json!({}).to_string(),
    };
    if std::fs::write(&path, body).is_ok() {
        let _ = file_modes::make_private(&path);
    }
}

/// Narrow wrapper so the unix-only chmod stays in one cfg'd spot.
mod file_modes {
    pub fn make_private(path: &std::path::Path) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        }
        #[cfg(not(unix))]
        {
            let _ = path;
            Ok(())
        }
    }
}

/// The auth pair the worker should start with.
pub fn initial_auth() -> Auth {
    Auth { server: server_url(), cookie: load_cookie() }
}
