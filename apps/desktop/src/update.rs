//! Event handling: net events into state, and the refresh map (which live
//! signal refetches what), mirroring `lib/app-state.tsx` + `lib/live.ts`.

use crate::net::api::list;
use crate::net::endpoints::Fetch;
use crate::net::types::*;
use crate::net::Event;
use crate::state::{App, Gate, Route};

/// One `poll`: net events, bridge events, chat sync, toast expiry. True when
/// anything changed.
pub fn tick(app: &mut App, events: Vec<Event>) -> bool {
    let mut changed = apply_bridge(app);
    for e in events {
        if apply_one(app, e) {
            changed = true;
        }
    }
    if sync_chat(app) {
        changed = true;
    }
    if app.toast.is_some() && now_millis() - app.toast_at.unwrap_or(0.0) > 2600.0 {
        app.toast = None;
        changed = true;
    }
    changed
}

/// The bridge's events (chord state) into the chat cache.
fn apply_bridge(app: &mut App) -> bool {
    let mut changed = false;
    for event in app.bridge.take() {
        match event {
            crate::bridge::BridgeEvent::Ready => {
                if let Some(id) = app.chat_session.clone() {
                    app.bridge.attach(&id);
                }
            }
            crate::bridge::BridgeEvent::Link(status) => {
                let live = status == "live";
                app.chat_live = live;
                if !live {
                    app.chat_loaded = false;
                }
                changed = true;
            }
            crate::bridge::BridgeEvent::Session { id, loaded, state } => {
                if app.chat_session.as_deref() == Some(id.as_str()) {
                    app.chat_loaded = loaded;
                    let entries = state.get("transcript").and_then(serde_json::Value::as_array).cloned().unwrap_or_default();
                    app.chat = entries.iter().filter_map(crate::state::ChatMessage::of).collect();
                    app.chat_phase = state.get("phase").and_then(serde_json::Value::as_str).unwrap_or("idle").to_string();
                    app.chat_pending = state.get("pending").filter(|p| !p.is_null()).cloned();
                    changed = true;
                }
            }
            crate::bridge::BridgeEvent::Decided { .. } => {
                app.net.fetch(crate::net::endpoints::Fetch::Approvals);
                changed = true;
            }
            crate::bridge::BridgeEvent::Error(message) => {
                app.toast = Some(message);
                app.toast_at = Some(now_millis());
                changed = true;
            }
        }
    }
    changed
}

fn apply_one(app: &mut App, e: Event) -> bool {
    match e {
        Event::Payload(f, v) => payload(app, f, v),
        Event::Done(tag, ok, msg) => {
            done(app, tag, ok, msg);
            true
        }
        Event::Signal(kind) => {
            signal(app, &kind);
            true
        }
        Event::PushStatus(word) => {
            if app.push != word {
                app.push = word;
                true
            } else {
                false
            }
        }
        Event::Expired => {
            app.cookie = None;
            app.gate = Gate::Checking;
            true
        }
    }
}

fn payload(app: &mut App, f: Fetch, v: serde_json::Value) -> bool {
    match f {
        Fetch::Sessions => match list::<SessionInfo>(v) {
            Ok(s) => {
                app.sessions = s;
                app.mark_loaded("sessions");
            }
            Err(m) => app.note_error("sessions", err_text(m)),
        },
        Fetch::Profiles => match list::<ProfileInfo>(v) {
            Ok(p) => {
                app.profiles = p;
                app.mark_loaded("profiles");
            }
            Err(m) => app.note_error("profiles", err_text(m)),
        },
        Fetch::Models => {
            app.models = v
                .get("models")
                .and_then(|m| serde_json::from_value::<Vec<ModelInfo>>(m.clone()).ok())
                .unwrap_or_default();
            app.workspace_default = v
                .get("workspaceDefault")
                .and_then(|m| serde_json::from_value::<ProfileModel>(m.clone()).ok());
            app.mark_loaded("models");
        }
        Fetch::Tasks => match list::<TaskInfo>(v) {
            Ok(t) => {
                app.tasks = t;
                app.mark_loaded("tasks");
            }
            Err(m) => app.note_error("tasks", err_text(m)),
        },
        Fetch::Approvals => match list::<Approval>(v) {
            Ok(a) => {
                app.approvals = a;
                app.mark_loaded("approvals");
            }
            Err(m) => app.note_error("approvals", err_text(m)),
        },
        Fetch::NeedsYou => match serde_json::from_value::<NeedsYou>(v) {
            Ok(n) => {
                app.needs = Some(n);
                app.mark_loaded("needs-you");
            }
            Err(m) => app.note_error("needs-you", err_text(m)),
        },
        Fetch::ServerCheck => match serde_json::from_value::<ServerCheck>(v) {
            Ok(c) => {
                app.check = Some(c);
                app.mark_loaded("server-check");
            }
            Err(m) => app.note_error("server-check", err_text(m)),
        },
        Fetch::Settings => {
            if let (Some(p), Ok(paused)) = (v.get("pause"), serde_json::from_value::<bool>(v["pause"].clone())) {
                let _ = p;
                app.settings.paused = Some(paused);
            }
            app.settings.model_ref = v["model"]["ref"].as_str().map(String::from);
            app.settings.effort = v["model"]["effort"].as_str().map(String::from);
            app.settings.max_running_tasks = v["tasks"]["maxRunningTasks"].as_f64();
            app.mark_loaded("settings");
        }
        Fetch::Artifacts(_) => match list::<ArtifactInfo>(v) {
            Ok(a) => {
                app.artifacts = a;
                app.mark_loaded("artifacts");
            }
            Err(m) => app.note_error("artifacts", err_text(m)),
        },
        Fetch::Projects => {
            app.projects = rows(v);
            app.mark_loaded("projects");
        }
        Fetch::Cron => {
            app.cron = rows(v);
            app.mark_loaded("cron");
        }
        Fetch::Webhooks => {
            app.webhooks = rows(v);
            app.mark_loaded("webhooks");
        }
        Fetch::Sensors => {
            app.sensors = rows(v);
            app.mark_loaded("sensors");
        }
        Fetch::Rooms => {
            app.rooms = rows(v);
            app.mark_loaded("rooms");
        }
        Fetch::Room(id) => {
            let tag = format!("room:{id}");
            if v.get("room").is_some() {
                app.room = Some(v.clone());
                app.mark_loaded(&tag);
            } else {
                app.note_error(&tag, "not found".into());
            }
        }
        Fetch::Skills => {
            app.skills = rows(v);
            app.mark_loaded("skills");
        }
        Fetch::Vault => {
            app.vault = rows(v);
            app.mark_loaded("vault");
        }
        Fetch::VaultBindings => {
            app.bindings = rows(v);
            app.mark_loaded("vault-bindings");
        }
        Fetch::McpServers => {
            app.mcp = rows(v);
            app.mark_loaded("connectors");
        }
        Fetch::Audit(_) => {
            app.audit = rows(v);
            app.mark_loaded("audit");
        }
        Fetch::History(_) => {
            app.history = rows_of_groups(&v);
            app.message_search = v.get("groups").and_then(|g| g.as_array()).map(|a| a.clone());
            app.mark_loaded("history");
        }
        Fetch::Main(profile) => {
            let tag = format!("main:{profile}");
            match serde_json::from_value::<SessionInfo>(v) {
                Ok(s) => {
                    if !app.sessions.iter().any(|x| x.id == s.id) {
                        app.sessions.push(s);
                    }
                    app.mark_loaded(&tag);
                }
                Err(m) => app.note_error(&tag, err_text(m)),
            }
        }
        Fetch::TaskActivity(id) => {
            let tag = format!("activity:{id}");
            app.loaded.insert(tag);
        }
        Fetch::ArtifactText(id) => {
            let tag = format!("file:{id}");
            app.previews.insert(id, v.get("text").and_then(serde_json::Value::as_str).unwrap_or("").to_string());
            app.mark_loaded(&tag);
        }
        Fetch::Usage(_) => {
            app.mark_loaded("usage");
        }
        Fetch::Nodes | Fetch::PushConfig => {
            app.mark_loaded("nodes");
        }
        Fetch::Org => {
            app.org = Some(v);
            app.mark_loaded("org");
        }
        Fetch::AuthStatus => {
            app.passcode_set = v.get("passcodeSet").and_then(serde_json::Value::as_bool);
            app.has_session = v.get("session").and_then(serde_json::Value::as_bool);
            open_gate(app);
        }
    }
    true
}

/// After the auth status lands: in, or the sign-in form.
fn open_gate(app: &mut App) {
    if app.has_session == Some(true) {
        app.gate = Gate::Ready;
        refresh_all(app);
    } else {
        let first = app.passcode_set != Some(true);
        if !matches!(app.gate, Gate::SignIn { .. }) {
            app.gate = Gate::SignIn { passcode: rune::TextEdit::new(String::new()), error: None, first };
        }
    }
}

fn rows(v: serde_json::Value) -> Vec<Row> {
    match v {
        serde_json::Value::Array(a) => a,
        serde_json::Value::Object(o) => o
            .into_iter()
            .find(|(_, v2)| v2.is_array())
            .map(|(_, v2)| v2.as_array().unwrap().clone())
            .unwrap_or_default(),
        _ => vec![],
    }
}

fn rows_of_groups(v: &serde_json::Value) -> Vec<Row> {
    v.get("groups").and_then(|g| g.as_array()).map(|a| a.clone()).unwrap_or_default()
}

fn done(app: &mut App, tag: String, ok: bool, msg: Option<String>) {
    if ok {
        // A sign-in stores its cookie and opens the app; a sign-out closes it.
        if tag == "sign-in" {
            app.cookie = msg.clone();
            crate::config::save_cookie(msg.as_deref());
            app.gate = Gate::Ready;
            refresh_all(app);
        } else if tag == "sign-out" {
            app.cookie = None;
            crate::config::save_cookie(None);
            app.has_session = Some(false);
            app.gate = Gate::SignIn { passcode: rune::TextEdit::new(String::new()), error: None, first: false };
        } else if tag == "set-passcode" {
            app.passcode_set = Some(true);
            app.gate = Gate::SignIn { passcode: rune::TextEdit::new(String::new()), error: None, first: false };
        }
        app.toast = Some("Saved".into());
        app.toast_at = Some(now_millis());
        // The mutations that change a cache refresh it right away.
        if tag.starts_with("create-profile:") || tag.starts_with("patch-profile:") {
            app.net.fetch(Fetch::Profiles);
            app.net.fetch(Fetch::Sessions);
        } else if tag.starts_with("cron") {
            app.net.fetch(Fetch::Cron);
        } else if tag.starts_with("hook") {
            app.net.fetch(Fetch::Webhooks);
        } else if tag == "pause" || tag == "set-model" || tag == "set-tasks-max" {
            app.net.fetch(Fetch::Settings);
        } else if tag.starts_with("cancel:") || tag.starts_with("retry:") {
            app.net.fetch(Fetch::Tasks);
            app.net.fetch(Fetch::NeedsYou);
        } else if tag.starts_with("decide:") {
            app.net.fetch(Fetch::Approvals);
            app.net.fetch(Fetch::NeedsYou);
        }
        return;
    }
    if let Some(m) = msg {
        if tag == "sign-in" {
            if let Gate::SignIn { error, .. } = &mut app.gate {
                *error = Some(m);
            }
            return;
        }
        app.toast = Some(m);
        app.toast_at = Some(now_millis());
    }
}

/// Which fetches each live signal refreshes (docs/LIVE.md's table).
fn signal(app: &mut App, kind: &str) {
    let fetches: &[Fetch] = match kind {
        "tasks" => &[Fetch::Tasks, Fetch::NeedsYou],
        "approvals" => &[Fetch::Approvals, Fetch::NeedsYou],
        "needs-you" => &[Fetch::NeedsYou],
        "sessions" | "profiles" => &[Fetch::Sessions, Fetch::Profiles, Fetch::Models],
        "routines" => &[Fetch::Cron, Fetch::Webhooks, Fetch::Sensors],
        "vault" => &[Fetch::Vault, Fetch::VaultBindings],
        "skills" => &[Fetch::Skills],
        "projects" => &[Fetch::Projects],
        "connectors" => &[Fetch::McpServers],
        "mailbox" => &[Fetch::Rooms],
        "takeovers" => &[],
        _ => &[],
    };
    for f in fetches {
        app.net.fetch(f.clone());
    }
}

/// The boot (and sign-in) sequence: everything the chrome and home need.
pub fn refresh_all(app: &mut App) {
    for f in [
        Fetch::Sessions,
        Fetch::Profiles,
        Fetch::Models,
        Fetch::Tasks,
        Fetch::Approvals,
        Fetch::NeedsYou,
        Fetch::ServerCheck,
        Fetch::Settings,
    ] {
        app.net.fetch(f);
    }
}

/// A screen asks for its own data when it mounts (use-live-load's job).
pub fn refresh_route(app: &mut App) {
    let f: Vec<Fetch> = match &app.route {
        Route::Now => vec![Fetch::Projects, Fetch::Artifacts(8)],
        Route::Crew => vec![Fetch::Org],
        Route::Profile(_, _) => vec![Fetch::Audit("limit=50".into())],
        Route::Routines => vec![Fetch::Cron, Fetch::Webhooks, Fetch::Sensors],
        Route::Rooms => vec![Fetch::Rooms],
        Route::Tools(_) => vec![Fetch::McpServers, Fetch::Skills, Fetch::Vault, Fetch::VaultBindings],
        Route::Settings => vec![Fetch::Nodes],
        _ => vec![],
    };
    for f in f {
        app.net.fetch(f);
    }
}

/// Keep the bridge attached to the chat the route shows: the current bot's
/// main chat on Home, the picked chat on `/c/:id`. Attach on change.
fn sync_chat(app: &mut App) -> bool {
    if app.gate != Gate::Ready {
        return false;
    }
    let wanted = match &app.route {
        Route::Home => app.current_bot_id().and_then(|bot| {
            app.sessions.iter().find(|s| s.kind == "main" && s.profile == bot).map(|s| s.id.clone())
        }),
        Route::Chat(id) => Some(id.clone()),
        _ => None,
    };
    if wanted == app.chat_session {
        return false;
    }
    if let Some(old) = app.chat_session.clone() {
        app.bridge.detach(&old);
    }
    app.chat_session = wanted.clone();
    app.chat.clear();
    app.chat_loaded = false;
    if let Some(id) = wanted {
        app.bridge.attach(&id);
    }
    true
}

fn err_text<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn now_millis() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}
