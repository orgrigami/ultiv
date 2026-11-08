//! The Spriessen desktop client: a thin native window over the same REST +
//! /push + chord surface the web client uses. Development gate:
//! `DESKTOP_APP_ACTIVE=1` (the install builds it only when set).

mod bridge;
mod config;
mod net;
mod state;
mod theme;
mod ui;
mod update;

use net::endpoints::Fetch;
use state::{App, Gate};
use update::tick;

fn setup(s: &mut App, waker: rune::Waker) {
    s.server = config::server_url();
    let auth = config::initial_auth();
    s.cookie = auth.cookie.clone();
    let rx = s.rx.take().expect("one job receiver");
    s.net.spawn(waker.clone(), rx);
    s.net.set_auth(auth);
    s.net.fetch(Fetch::AuthStatus);
    s.bridge.spawn(waker, &s.server, s.cookie.as_deref().unwrap_or(""));
}

fn poll(s: &mut App, now: f64, tx: &mut rune::Tx) -> bool {
    let events = s.net.take();
    if std::env::var("SPRIESSEN_TRACE").is_ok() && now < 600.0 {
        eprintln!("poll: t={now:.2} events={} changed_pre", events.len());
    }
    let changed = tick(s, events);
    if route_changed(s) {
        update::refresh_route(s);
    }
    // Keep poll pumping while replies are in flight: a wake each poll costs
    // one poll a frame, and a still app draws nothing when poll says false.
    tx.wake_after(std::time::Duration::from_millis(30));
    changed
}

/// The screens remount on a route change: their data refresh then.
fn route_changed(s: &mut App) -> bool {
    let changed = s.mounted_route.as_ref() != Some(&s.route) && s.gate == Gate::Ready;
    if changed {
        s.mounted_route = Some(s.route.clone());
    }
    changed
}

fn keys(s: &mut App, ev: &rune::KeyEvent, tx: &mut rune::Tx) -> bool {
    let cmd_k = rune::Chord::parse("mod+k").map(|c| c.matches_tx(ev, tx)).unwrap_or(false);
    let n = matches!(&ev.key, rune::Key::Text(t) if t == "n")
        && !ev.mods.shift
        && !ev.mods.alt
        && !ev.mods.cmd
        && !in_field(tx);
    let esc = matches!(ev.key, rune::Key::Escape);
    if cmd_k {
        s.switcher = if s.switcher.is_some() {
            None
        } else {
            s.switcher_edit = rune::TextEdit::new(String::new());
            Some(state::Switcher { active: 0 })
        };
        return true;
    }
    if esc && s.switcher.is_some() {
        s.switcher = None;
        return true;
    }
    if n && s.switcher.is_none() && s.gate == Gate::Ready {
        let Some(bot) = s.current_bot_id() else { return false };
        let tag = format!("new-chat:{bot}");
        s.net.mutate(net::endpoints::Mutation::NewChat(bot.clone()), &tag);
        return true;
    }
    false
}

fn in_field(tx: &mut rune::Tx) -> bool {
    tx.focused().is_some()
}

fn main() {
    rune::run(AppSpec::<App> {
        setup: Some(setup),
        poll: Some(poll),
        on_key: Some(keys),
        scenes: SCENES,
        families: ("Inter", "ui-monospace"),
        ..AppSpec::new("Spriessen", (1180.0, 780.0), App::default, ui::view)
    });
}

/// Headless scenes: each names the screen a snapshot wants.
static SCENES: &[(&str, fn(&mut App))] = &[
    ("now", |s: &mut App| s.route = Route::Now),
    ("crew", |s: &mut App| s.route = Route::Crew),
    ("settings", |s: &mut App| s.route = Route::Settings),
    ("routines", |s: &mut App| s.route = Route::Routines),
    ("history", |s: &mut App| s.route = Route::History),
    ("rooms", |s: &mut App| s.route = Route::Rooms),
    ("tools", |s: &mut App| s.route = Route::Tools(state::ToolsTab::Connectors)),
    ("light", |s: &mut App| s.theme = state::ThemeMode::Light),
];

use state::Route;

use rune::AppSpec;
