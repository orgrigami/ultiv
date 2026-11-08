//! The network layer: one worker thread runs REST jobs and a second runs the
//! /push socket; results land in a shared inbox the app drains in `poll`
//! (one wake per arrival, never a polling loop).

pub mod api;
pub mod endpoints;
pub mod push;
pub mod types;

use api::{ApiError, Auth};
use endpoints::{Fetch, Mutation};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// One event the UI thread consumes. Typed payloads for the core entities;
/// raw JSON for the long tail (extracted at the view).
#[derive(Clone, Debug)]
pub enum Event {
    /// A fetch's payload arrived (the app maps it into its caches).
    Payload(Fetch, serde_json::Value),
    /// A raw-bytes fetch arrived (image previews).
    Bytes(String, Arc<Vec<u8>>),
    /// One live cast frame (base64 image, its page size and location).
    CastFrame { id: String, data: String, w: f64, h: f64, url: String, title: String },
    /// The cast's VM answered; taps act from here.
    CastReady(String),
    /// The cast ended (the ask finished, failed or was cancelled).
    CastClosed(String),
    /// A mutation finished: tag names the caller, ok whether it landed,
    /// and the message carries a failure's words (or the sign-in cookie).
    Done(String, bool, Option<String>),
    /// A coarse /push signal (never carries data).
    Signal(String),
    /// The push socket's state, for the chrome's connected/connecting word.
    PushStatus(&'static str),
    /// The session ended (401 REST or 4401 socket): show the sign-in gate.
    Expired,
}

/// What the worker and the push thread share.
pub struct Shared {
    pub inbox: Mutex<VecDeque<Event>>,
    pub auth: Mutex<Auth>,
    /// Bumped on SetAuth so the push thread reconnects with it.
    pub generation: AtomicBool,
}

impl Shared {
    fn deliver(&self, e: Event) {
        self.inbox.lock().unwrap().push_back(e);
    }
}

/// The UI-side handle: queue jobs, take events.
#[derive(Clone)]
pub struct Net {
    shared: Arc<Shared>,
    tx: std::sync::mpsc::Sender<Job>,
}

pub enum Job {
    Fetch(Fetch),
    Mutate(Mutation, String),
    SetAuth(Auth),
    Download { id: String, name: String },
    Cast { id: String },
    CastAct { id: String, body: serde_json::Value, tag: String },
}

impl Net {
    /// The handle and the receiver the app passes back to `spawn`.
    pub fn new() -> (Net, std::sync::mpsc::Receiver<Job>) {
        let (tx, rx) = std::sync::mpsc::channel();
        let shared = Arc::new(Shared {
            inbox: Mutex::new(VecDeque::new()),
            auth: Mutex::new(Auth::default()),
            generation: AtomicBool::new(false),
        });
        (Net { shared, tx }, rx)
    }

    /// Start the REST worker and the push thread; the waker fires per event.
    pub fn spawn(&self, waker: rune::Waker, rx: std::sync::mpsc::Receiver<Job>) {
        let rest_shared = self.shared.clone();
        std::thread::Builder::new()
            .name("spriessen-rest".into())
            .spawn(move || rest_worker(rest_shared, rx, waker))
            .expect("spawn rest worker");
        let push_shared = self.shared.clone();
        std::thread::Builder::new()
            .name("spriessen-push".into())
            .spawn(move || push::run(push_shared))
            .expect("spawn push thread");
    }

    pub fn fetch(&self, f: Fetch) {
        let _ = self.tx.send(Job::Fetch(f));
    }

    /// `tag` comes back in `Event::Done` so the screen that asked can react.
    pub fn mutate(&self, m: Mutation, tag: &str) {
        let _ = self.tx.send(Job::Mutate(m, tag.to_string()));
    }

    /// Save an artifact into `~/Downloads/spriessen/`.
    pub fn download(&self, id: String, name: String) {
        let _ = self.tx.send(Job::Download { id, name });
    }

    /// Open the takeover's live cast (its own SSE reader thread).
    pub fn cast(&self, id: String) {
        let _ = self.tx.send(Job::Cast { id });
    }

    /// One owner act on the live view.
    pub fn cast_act(&self, id: String, body: serde_json::Value, tag: String) {
        let _ = self.tx.send(Job::CastAct { id, body, tag });
    }

    /// Point the worker at a server (and cookie); the push thread reconnects.
    pub fn set_auth(&self, auth: Auth) {
        let _ = self.tx.send(Job::SetAuth(auth));
    }

    /// Drain everything that landed since the last drain.
    pub fn take(&self) -> Vec<Event> {
        self.shared.inbox.lock().unwrap().drain(..).collect()
    }
}

fn rest_worker(shared: Arc<Shared>, rx: std::sync::mpsc::Receiver<Job>, waker: rune::Waker) {
    let mut client = api::Client::new();
    while let Ok(job) = rx.recv() {
        let trace = std::env::var("SPRIESSEN_TRACE").is_ok();
        if trace {
            eprintln!("net: job in");
        }
        match job {
            Job::SetAuth(auth) => {
                *shared.auth.lock().unwrap() = auth.clone();
                client.auth = auth;
                shared.generation.store(true, Ordering::Relaxed);
            }
            Job::Fetch(f) => {
                if let Some(bytes) = endpoints::run_fetch_bytes(&client, &f) {
                    match bytes {
                        Ok(b) => {
                            let id = match &f {
                                endpoints::Fetch::ArtifactBytes(id) => id.clone(),
                                _ => String::new(),
                            };
                            shared.deliver(Event::Bytes(id, Arc::new(b)));
                            waker();
                        }
                        Err(ApiError::Expired) => {
                            shared.deliver(Event::Expired);
                            waker();
                        }
                        Err(ApiError::Failed(m)) => {
                            shared.deliver(Event::Done(f.tag(), false, Some(m)));
                            waker();
                        }
                    }
                    continue;
                }
                match endpoints::run_fetch(&client, &f) {
                Ok(v) => {
                    if trace {
                        eprintln!("net: fetch ok {}", f.tag());
                    }
                    shared.deliver(Event::Payload(f, v));
                    waker();
                }
                Err(ApiError::Expired) => {
                    if trace {
                        eprintln!("net: fetch expired {}", f.tag());
                    }
                    shared.deliver(Event::Expired);
                    waker();
                }
                    Err(ApiError::Failed(m)) => {
                        if trace {
                            eprintln!("net: fetch failed {} {m}", f.tag());
                        }
                        shared.deliver(Event::Done(f.tag(), false, Some(m)));
                        waker();
                    }
                }
            }
            Job::Mutate(m, tag) => match endpoints::run_mutation(&client, &m) {
                Ok(v) => {
                    shared.deliver(Event::Done(tag, true, cookie_of(&v)));
                    waker();
                }
                Err(ApiError::Expired) => {
                    shared.deliver(Event::Expired);
                    waker();
                }
                Err(ApiError::Failed(msg)) => {
                    shared.deliver(Event::Done(tag, false, Some(msg)));
                    waker();
                }
            },
            Job::Cast { id } => {
                // Its own thread: the stream never ends while the cast lives.
                let shared = shared.clone();
                let waker = waker.clone();
                let client = client.auth.clone();
                std::thread::Builder::new()
                    .name("spriessen-cast".into())
                    .spawn(move || cast_thread(client, shared, waker, id))
                    .expect("spawn cast thread");
            }
            Job::CastAct { id, body, tag } => {
                let path = format!("/api/browser/takeover/{id}/cast/act");
                match api::send_value(&client, api::Verb::Post, &path, body) {
                    Ok(_) => {
                        shared.deliver(Event::Done(tag, true, None));
                        waker();
                    }
                    Err(ApiError::Expired) => {
                        shared.deliver(Event::Expired);
                        waker();
                    }
                    Err(ApiError::Failed(msg)) => {
                        shared.deliver(Event::Done(tag, false, Some(msg)));
                        waker();
                    }
                }
            }
            Job::Download { id, name } => match download(&client, &id, &name) {
                Ok(path) => {
                    shared.deliver(Event::Done(format!("download:{id}"), true, Some(path)));
                    waker();
                }
                Err(ApiError::Expired) => {
                    shared.deliver(Event::Expired);
                    waker();
                }
                Err(ApiError::Failed(msg)) => {
                    shared.deliver(Event::Done(format!("download:{id}"), false, Some(msg)));
                    waker();
                }
            },
        }
    }
}

/// The one-time secrets some answers carry: the sign-in cookie, the paired
/// node's token, and a branch's new session id (each shown or acted on once).
fn cookie_of(v: &serde_json::Value) -> Option<String> {
    v.get("cookie")
        .or_else(|| v.get("token"))
        .and_then(serde_json::Value::as_str)
        .map(String::from)
        .or_else(|| v.get("id").and_then(serde_json::Value::as_str).map(String::from))
}

/// Fetch the bytes and write them beside the rest of the downloads.
fn download(client: &api::Client, id: &str, name: &str) -> api::ApiResult<String> {
    let bytes = api::get_bytes(client, &format!("/api/artifacts/{id}"))?;
    let dir = std::env::var("HOME")
        .map(|home| std::path::PathBuf::from(home).join("Downloads").join("spriessen"))
        .map_err(|_| api::ApiError::Failed("no home folder".into()))?;
    std::fs::create_dir_all(&dir).map_err(|e| api::ApiError::Failed(format!("{e}")))?;
    let safe: String = name.chars().map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' }).collect();
    let path = dir.join(safe);
    std::fs::write(&path, &bytes).map_err(|e| api::ApiError::Failed(format!("{e}")))?;
    Ok(path.to_string_lossy().to_string())
}

/// The cast SSE reader: `event:`/`data:` pairs into typed events, until the
/// stream closes (which is the cast ending).
fn cast_thread(auth: Auth, shared: Arc<Shared>, waker: rune::Waker, id: String) {
    let mut client = api::Client::new();
    client.auth = auth;
    let resp = match client.request(api::Verb::Get, &format!("/api/browser/takeover/{id}/cast"), None) {
        Ok(r) => r,
        Err(e) => {
            shared.inbox.lock().unwrap().push_back(Event::Done(format!("cast:{id}"), false, Some(match e {
                ApiError::Expired => "sign in required".into(),
                ApiError::Failed(m) => m,
            })));
            waker();
            return;
        }
    };
    let reader = resp.into_body().into_reader();
    let mut lines = std::io::BufReader::new(reader);
    let (mut event, mut data) = (String::new(), String::new());
    loop {
        let mut line = String::new();
        match std::io::BufRead::read_line(&mut lines, &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let line = line.trim_end_matches(['\n', '\r']);
        if line.is_empty() {
            // Dispatch the completed pair.
            if !event.is_empty() && !data.is_empty() {
                let payload: serde_json::Value = serde_json::from_str(&data).unwrap_or(serde_json::Value::Null);
                let e = cast_event(&id, &event, payload);
                shared.inbox.lock().unwrap().push_back(e);
                waker();
            }
            (event, data) = (String::new(), String::new());
            continue;
        }
        if let Some(rest) = line.strip_prefix("event: ") {
            event = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("data: ") {
            data = rest.to_string();
        }
    }
    shared.inbox.lock().unwrap().push_back(Event::CastClosed(id));
    waker();
}

/// One SSE pair into the event the view consumes.
fn cast_event(id: &str, event: &str, payload: serde_json::Value) -> Event {
    match event {
        "frame" => Event::CastFrame {
            id: id.to_string(),
            data: payload.get("data").and_then(serde_json::Value::as_str).unwrap_or("").to_string(),
            w: payload.get("w").and_then(serde_json::Value::as_f64).unwrap_or(0.0),
            h: payload.get("h").and_then(serde_json::Value::as_f64).unwrap_or(0.0),
            url: payload.get("url").and_then(serde_json::Value::as_str).unwrap_or("").to_string(),
            title: payload.get("title").map(|t| t.to_string()).unwrap_or_default(),
        },
        "ready" => Event::CastReady(id.to_string()),
        "cast-error" => Event::Done(
            format!("cast:{id}"),
            false,
            Some(payload.get("error").and_then(serde_json::Value::as_str).unwrap_or("the cast failed").to_string()),
        ),
        _ => Event::CastClosed(id.to_string()),
    }
}

impl Fetch {
    /// The tag a failed fetch reports under (the same key the screen waits on).
    pub fn tag(&self) -> String {
        match self {
            Fetch::Room(id) => format!("room:{id}"),
            Fetch::TaskActivity(id) => format!("activity:{id}"),
            Fetch::Usage(p) => format!("usage:{p}"),
            Fetch::Main(p) => format!("main:{p}"),
            Fetch::History(_) => "history".into(),
            Fetch::Audit(_) => "audit".into(),
            other => format!("{other:?}").to_lowercase(),
        }
    }
}
