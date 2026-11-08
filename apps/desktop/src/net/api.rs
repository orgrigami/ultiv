//! The REST surface over ureq 3: the transport half lives here (one agent per
//! worker, statuses as responses so the server's error words reach the UI,
//! 401 mapped to `ApiError::Expired`); the endpoint dispatch is `endpoints.rs`.

use serde::Deserialize;
use ureq::http::{Request, Response, StatusCode};
use ureq::Body;

/// Where requests go and who the owner is this run.
#[derive(Clone, Default)]
pub struct Auth {
    pub server: String,
    pub cookie: Option<String>,
}

#[derive(Debug)]
pub enum ApiError {
    /// 401 on REST: the session ended; the UI returns to the sign-in gate.
    Expired,
    Failed(String),
}

pub type ApiResult<T> = Result<T, ApiError>;

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::Expired => write!(f, "sign in required"),
            ApiError::Failed(m) => write!(f, "{m}"),
        }
    }
}

pub enum Verb {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

/// One agent per worker thread (its pool rides along), aimed at `auth`.
pub struct Client {
    pub auth: Auth,
    agent: ureq::Agent,
}

impl Client {
    pub fn new() -> Client {
        let agent = ureq::Agent::config_builder().http_status_as_error(false).build().new_agent();
        Client { auth: Auth::default(), agent }
    }

    /// One HTTP round trip; `body` serialized JSON or empty for bodyless verbs.
    pub fn request(&self, verb: Verb, path: &str, body: Option<String>) -> ApiResult<Response<Body>> {
        let url = format!("{}{}", self.auth.server, path);
        let method = match verb {
            Verb::Get => "GET",
            Verb::Post => "POST",
            Verb::Put => "PUT",
            Verb::Patch => "PATCH",
            Verb::Delete => "DELETE",
        };
        let mut builder = Request::builder().method(method).uri(&url);
        if let Some(c) = &self.auth.cookie {
            builder = builder.header("Cookie", c.clone());
        }
        let req = match body {
            Some(json) => builder
                .header("Content-Type", "application/json")
                .body(json)
                .map_err(|e| ApiError::Failed(e.to_string()))?,
            None => builder.body(String::new()).map_err(|e| ApiError::Failed(e.to_string()))?,
        };
        self.agent.run(req).map_err(|e| ApiError::Failed(e.to_string()))
    }
}

fn words(resp: &mut Response<Body>) -> String {
    let text = resp.body_mut().read_to_string().unwrap_or_default();
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("error").and_then(serde_json::Value::as_str).map(String::from))
        .unwrap_or_else(|| text.chars().take(160).collect())
}

fn guard(resp: &mut Response<Body>) -> ApiResult<()> {
    let status = resp.status();
    if status == StatusCode::UNAUTHORIZED {
        return Err(ApiError::Expired);
    }
    if status.is_client_error() || status.is_server_error() {
        return Err(ApiError::Failed(words(resp)));
    }
    Ok(())
}

fn json_of(resp: &mut Response<Body>) -> ApiResult<serde_json::Value> {
    let text = resp.body_mut().read_to_string().unwrap_or_default();
    if text.is_empty() {
        return Ok(serde_json::json!({ "ok": true }));
    }
    serde_json::from_str(&text).map_err(|e| ApiError::Failed(e.to_string()))
}

/// GET one endpoint, guarded, parsed.
pub fn get_value(client: &Client, path: &str) -> ApiResult<serde_json::Value> {
    let mut resp = client.request(Verb::Get, path, None)?;
    guard(&mut resp)?;
    json_of(&mut resp)
}

/// GET a body as text (file previews; capped by the server's own limits).
pub fn get_text(client: &Client, path: &str) -> ApiResult<String> {
    let mut resp = client.request(Verb::Get, path, None)?;
    guard(&mut resp)?;
    resp.body_mut().read_to_string().map_err(|e| ApiError::Failed(e.to_string()))
}

/// GET a body as bytes (image previews).
pub fn get_bytes(client: &Client, path: &str) -> ApiResult<Vec<u8>> {
    let mut resp = client.request(Verb::Get, path, None)?;
    guard(&mut resp)?;
    resp.body_mut().read_to_vec().map_err(|e| ApiError::Failed(e.to_string()))
}

/// A bodyful verb with a JSON payload; DELETE goes bodyless.
pub fn send_value(client: &Client, verb: Verb, path: &str, body: serde_json::Value) -> ApiResult<serde_json::Value> {
    let payload = match verb {
        Verb::Get | Verb::Delete => None,
        _ => Some(body.to_string()),
    };
    let mut resp = client.request(verb, path, payload)?;
    guard(&mut resp)?;
    json_of(&mut resp)
}

/// The sign-in round trip; the caller stores the Set-Cookie value.
pub fn sign_in(client: &Client, passcode: &str) -> ApiResult<String> {
    let mut resp = client.request(
        Verb::Post,
        "/api/auth/sign-in",
        Some(serde_json::json!({ "passcode": passcode }).to_string()),
    )?;
    guard(&mut resp)?;
    resp.headers()
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(';').next().unwrap_or(s).to_string())
        .ok_or_else(|| ApiError::Failed("no session cookie".into()))
}

/// Typed reads the screens hold as structs.
pub fn list<T: for<'de> Deserialize<'de>>(v: serde_json::Value) -> ApiResult<Vec<T>> {
    serde_json::from_value(v).map_err(|e| ApiError::Failed(e.to_string()))
}
