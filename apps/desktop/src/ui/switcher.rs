//! The quick switcher: Cmd/Ctrl-K, ranked over screens, bots and past chats
//! (`lib/quick-switch.ts`'s groups and order; arrows come with the field's
//! focus, so selection is pointer/Enter driven).

use crate::state::{App, Route};
use crate::ui::common::{self, ty};
use rune::tok::space;
use rune::{col, el, text, Color, El};

struct Hit {
    kind: &'static str,
    label: String,
    detail: String,
    go: Go,
}

#[derive(Clone)]
enum Go {
    Route(Route),
    Bot(String),
    Theme,
}

pub fn view(s: &App, dark: bool) -> Vec<El> {
    let Some(sw) = &s.switcher else { return vec![] };
    let t = crate::theme::tokens(dark);
    let k = crate::theme::kit(dark);
    let hits = rank(s, &s.switcher_edit.text);
    let active = sw.active.min(hits.len().saturating_sub(1));
    let mut list = col().key("switcher-list").gap(2.0);
    for (i, hit) in hits.iter().enumerate() {
        let selected = i == active;
        let go = hit.go.clone();
        list = list.child(
            el()
                .key(format!("hit:{i}"))
                .w_full()
                .min_h(40.0)
                .px(space::S3)
                .py(space::S1)
                .gap(space::S2)
                .center_y()
                .radius(9.0)
                .fill(if selected { t.wash(0.08) } else { Color::TRANSPARENT })
                .child(text(hit.kind.to_string()).font(ty::META).color(t.muted_fg).w(64.0))
                .child(text(hit.label.clone()).font(ty::UI_MED).color(t.fg).max_lines(1).grow(1.0))
                .children(
                    (!hit.detail.is_empty())
                        .then(|| text(hit.detail.clone()).font(ty::META).color(t.muted_fg).max_lines(1)),
                )
                .focusable(true)
                .on_press(move |s: &mut App| run(s, go.clone())),
        );
    }
    if hits.is_empty() {
        list = list.child(common::empty_state("Nothing matches.", dark));
    }
    vec![el()
        .key("switcher-scrim")
        .absolute(0.0, 0.0)
        .w_full()
        .h_full()
        .fill(Color::BLACK.alpha(0.35))
        .child(
            col()
                .key("switcher")
                .w(560.0)
                .mt(90.0)
                .padding(space::S2)
                .radius(25.0)
                .fill(t.popover)
                .border(1.0, t.hairline)
                .shadow(12.0, 32.0, Color::BLACK.alpha(0.4))
                .child(
                    rune_kit::TextInput::new(&s.switcher_edit)
                        .placeholder("Search bots, chats and screens")
                        .on_submit(|s: &mut App, _| run_active(s))
                        .build(&k),
                )
                .child(list),
        )]
}

fn run_active(s: &mut App) {
    let Some(sw) = &s.switcher else { return };
    let hits = rank(s, &s.switcher_edit.text);
    let Some(hit) = hits.get(sw.active.min(hits.len().saturating_sub(1))) else { return };
    run(s, hit.go.clone());
}

fn run(s: &mut App, go: Go) {
    s.switcher = None;
    match go {
        Go::Route(route) => s.route = route,
        Go::Bot(id) => {
            s.last_bot = Some(id);
            s.route = Route::Home;
        }
        Go::Theme => s.theme = s.theme.next(),
    }
}

/// The ranked hits for a query: actions, screens, bots (chat + profile),
/// then past chats. Empty query: the screens and the five newest chats.
fn rank(s: &App, query: &str) -> Vec<Hit> {
    let mut hits: Vec<Hit> = Vec::new();
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        hits.extend(screens());
        let mut chats: Vec<_> = s.sessions.iter().filter(|x| x.kind != "main" && x.kind != "room").collect();
        chats.sort_by(|a, b| b.last_message_at.partial_cmp(&a.last_message_at).unwrap_or(std::cmp::Ordering::Equal));
        for c in chats.into_iter().take(5) {
            hits.push(chat_hit(s, c));
        }
        return hits;
    }
    hits.push(Hit {
        kind: "action",
        label: "New chat".into(),
        detail: String::new(),
        go: Go::Bot(s.current_bot_id().unwrap_or_default()),
    });
    hits.push(Hit { kind: "action", label: "Switch theme".into(), detail: String::new(), go: Go::Theme });
    hits.extend(screens().into_iter().filter(|h| matches(&h.label, &h.detail, &q)));
    for p in s.visible_bots() {
        if matches(&p.name, "", &q) {
            hits.push(Hit { kind: "bot", label: p.name.clone(), detail: "chat".into(), go: Go::Bot(p.id.clone()) });
            hits.push(Hit {
                kind: "bot",
                label: p.name.clone(),
                detail: "profile".into(),
                go: Go::Route(Route::Profile(p.id.clone(), crate::state::ProfileTab::Overview)),
            });
        }
    }
    let mut chats: Vec<_> = s.sessions.iter().filter(|x| x.kind != "main" && x.kind != "room").collect();
    chats.sort_by(|a, b| b.last_message_at.partial_cmp(&a.last_message_at).unwrap_or(std::cmp::Ordering::Equal));
    for c in chats.into_iter().take(20) {
        if matches(&c.title, &s.bot_name(&c.profile), &q) {
            hits.push(chat_hit(s, c));
        }
    }
    hits.truncate(12);
    hits
}

fn chat_hit(s: &App, c: &crate::net::types::SessionInfo) -> Hit {
    Hit {
        kind: "chat",
        label: c.title.clone(),
        detail: s.bot_name(&c.profile),
        go: Go::Route(Route::Chat(c.id.clone())),
    }
}

fn screens() -> Vec<Hit> {
    vec![
        Hit { kind: "go", label: "Now".into(), detail: String::new(), go: Go::Route(Route::Now) },
        Hit { kind: "go", label: "Chats".into(), detail: String::new(), go: Go::Route(Route::Home) },
        Hit { kind: "go", label: "Crew".into(), detail: String::new(), go: Go::Route(Route::Crew) },
        Hit { kind: "go", label: "Settings".into(), detail: String::new(), go: Go::Route(Route::Settings) },
        Hit { kind: "go", label: "Routines".into(), detail: String::new(), go: Go::Route(Route::Routines) },
        Hit { kind: "go", label: "Bot talks".into(), detail: String::new(), go: Go::Route(Route::Rooms) },
        Hit { kind: "go", label: "Past chats".into(), detail: String::new(), go: Go::Route(Route::History) },
        Hit {
            kind: "go",
            label: "Tools".into(),
            detail: String::new(),
            go: Go::Route(Route::Tools(crate::state::ToolsTab::Connectors)),
        },
    ]
}

/// matchScore's honest core: exact > prefix > word-start > substring.
fn matches(label: &str, detail: &str, q: &str) -> bool {
    let l = label.to_lowercase();
    let d = detail.to_lowercase();
    l == q || l.starts_with(q) || l.split(' ').any(|w| w.starts_with(q)) || l.contains(q) || (!d.is_empty() && d.contains(q))
}
