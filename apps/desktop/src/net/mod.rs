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
