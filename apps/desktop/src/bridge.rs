//! The chord bridge client: spawns the Node sidecar (`sidecar/bridge.mjs`,
//! the web's own chord client) and speaks JSON lines to it. Events land in
//! the net inbox; sends go through the sidecar's stdin.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

/// One line the sidecar sent.
#[derive(Clone, Debug)]
pub enum BridgeEvent {
    Ready,
    Link(&'static str),
    Session { id: String, loaded: bool, state: serde_json::Value },
    Decided { id: String, call_id: String, stored: Option<f64> },
    Error(String),
}

/// The handle the app state holds.
#[derive(Clone)]
pub struct Bridge {
    inner: Arc<Mutex<Option<ChildStdin>>>,
    inbox: Arc<Mutex<Vec<BridgeEvent>>>,
    pub live: Arc<std::sync::atomic::AtomicBool>,
}

impl Default for Bridge {
    fn default() -> Self {
        Bridge { inner: Arc::new(Mutex::new(None)), inbox: Arc::new(Mutex::new(Vec::new())), live: Arc::new(std::sync::atomic::AtomicBool::new(false)) }
    }
}

impl Bridge {
    /// Spawn `node bridge.mjs` (the first node on PATH, as the install pins).
    pub fn spawn(&self, waker: rune::Waker, server: &str, cookie: &str) {
        let script = script_path();
        let ws_url = format!("{server}/chord");
        let child = Command::new("node")
            .arg(&script)
            .arg("--url")
            .arg(&ws_url)
            .arg("--cookie")
            .arg(cookie)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        let Ok(mut child) = child else {
            *self.inner.lock().unwrap() = None;
            return;
        };
        let stdin = child.stdin.take();
        *self.inner.lock().unwrap() = stdin;
        let stdout = child.stdout.take().expect("sidecar stdout");
        let inbox = self.inbox.clone();
        let live = self.live.clone();
        thread::Builder::new().name("spriessen-bridge".into()).spawn(move || {
            let mut child = child;
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if let Some(event) = parse(&line) {
                    if matches!(event, BridgeEvent::Link("lost")) {
                        live.store(false, std::sync::atomic::Ordering::Relaxed);
                    }
                    if matches!(event, BridgeEvent::Link("live")) {
                        live.store(true, std::sync::atomic::Ordering::Relaxed);
                    }
                    inbox.lock().unwrap().push(event);
                    waker();
                }
            }
            live.store(false, std::sync::atomic::Ordering::Relaxed);
            let _ = child.wait();
        }).expect("spawn bridge reader");
    }

    /// Drain the events that landed since last time.
    pub fn take(&self) -> Vec<BridgeEvent> {
        self.inbox.lock().unwrap().drain(..).collect()
    }

    fn send(&self, line: serde_json::Value) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(stdin) = guard.as_mut() {
            let _ = writeln!(stdin, "{line}");
            let _ = stdin.flush();
        }
    }

    pub fn attach(&self, session: &str) {
        self.send(serde_json::json!({ "op": "attach", "id": session }));
    }

    pub fn detach(&self, session: &str) {
        self.send(serde_json::json!({ "op": "detach", "id": session }));
    }

    pub fn input(&self, session: &str, text: &str) {
        self.send(serde_json::json!({ "op": "input", "id": session, "text": text }));
    }

    pub fn decide(&self, session: &str, call_id: &str, approved: bool, always: bool) {
        self.send(serde_json::json!({ "op": "decide", "id": session, "callId": call_id, "approved": approved, "always": always }));
    }

    pub fn interrupt(&self, session: &str) {
        self.send(serde_json::json!({ "op": "interrupt", "id": session }));
    }
}

fn parse(line: &str) -> Option<BridgeEvent> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    Some(match v.get("op")?.as_str()? {
        "ready" => BridgeEvent::Ready,
        "link" => BridgeEvent::Link(if v.get("status").and_then(serde_json::Value::as_str) == Some("live") { "live" } else { "lost" }),
        "session" => BridgeEvent::Session {
            id: v.get("id")?.as_str()?.to_string(),
            loaded: v.get("loaded").and_then(serde_json::Value::as_bool).unwrap_or(false),
            state: v.get("state").cloned().unwrap_or(serde_json::Value::Null),
        },
        "decided" => BridgeEvent::Decided {
            id: v.get("id")?.as_str()?.to_string(),
            call_id: v.get("callId")?.as_str()?.to_string(),
            stored: v.get("stored").and_then(serde_json::Value::as_f64),
        },
        "error" => BridgeEvent::Error(v.get("message").and_then(serde_json::Value::as_str)?.to_string()),
        _ => return None,
    })
}

/// Where bridge.mjs lives: beside the binary, in the crate, or the install.
fn script_path() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("SPRIESSEN_BRIDGE") {
        return p.into();
    }
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("sidecar/bridge.mjs"));
            candidates.push(dir.join("../../sidecar/bridge.mjs"));
            candidates.push(dir.join("../../../apps/desktop/sidecar/bridge.mjs"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("sidecar/bridge.mjs"));
    }
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(std::path::PathBuf::from(home).join(".spriessen/sidecar/bridge.mjs"));
    }
    candidates.into_iter().find(|p| p.exists()).unwrap_or_else(|| "sidecar/bridge.mjs".into())
}

/// The child process handle is owned by the reader thread.
#[allow(dead_code)]
type OwnedChild = Child;
