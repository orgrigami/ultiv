//! The sidebar rail (the web's `w-64` rail at sm+): wordmark, New chat, Find,
//! the four sections, the crew roster under Crew, and the Recents list.

use crate::net::endpoints::Mutation;
use crate::state::{App, Route};
use crate::ui::common::{self, ty};
use rune::tok::space;
use rune::{col, el, text, Color, El};
use rune_kit::{Button, ButtonVariant, IconButton};
use rune::Icon;

pub static PLUS: Icon = Icon {
    name: "sp-plus",
    view: 16.0,
    body: r#"<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>"#,
};
pub static SEARCH: Icon = Icon {
    name: "sp-search",
    view: 16.0,
    body: r#"<circle cx="7" cy="7" r="4" stroke="currentColor" stroke-width="1.75" fill="none"/><path d="M10 10l3 3" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>"#,
};
pub static CLOCK: Icon = Icon {
    name: "sp-clock",
    view: 16.0,
    body: r#"<circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.75" fill="none"/><path d="M8 5v3.2l2 1.3" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>"#,
};

/// The whole rail, 256 points.
pub fn view(s: &App, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let k = crate::theme::kit(dark);
    col()
        .key("rail")
        .w(256.0)
        .h_full()
        .fill(t.sidebar)
        .border(1.0, t.hairline)
        .padding(space::S3)
        .gap(space::S2)
        .child(sections_top(s, dark, &k))
        .child(common::section_label("Crew", dark))
        .children(crew_rows(s, dark))
        .child(common::section_label("Recents", dark))
        .children(recents(s, dark))
        .child(el().key("rail-space").grow(1.0))
        .child(
            el()
                .key("rail-foot")
                .w_full()
                .px(space::S2)
                .child(text(s.push.to_string()).font(ty::META).color(t.muted_fg)),
        )
}

fn sections_top(s: &App, dark: bool, k: &rune_kit::Kit) -> El {
    col()
        .key("rail-top")
        .gap(space::S2)
        .child(super::gate::brand_wordmark(dark))
        .child(
            el()
                .key("rail-actions")
                .gap(space::S2)
                .child(Button::new("New chat").variant(ButtonVariant::Neutral).expanded(true).on_press(new_chat).build(k))
                .child(IconButton::new(&SEARCH).label("Find").on_press(|s: &mut App| open_switcher(s)).build(k)),
        )
        .child(nav_section(s, dark, "Now", Route::Now, Some(s.needs_count())))
        .child(nav_section(s, dark, "Chats", Route::Home, None))
        .child(nav_section(s, dark, "Crew", Route::Crew, None))
        .child(nav_section(s, dark, "Settings", Route::Settings, None))
}

fn nav_section(s: &App, dark: bool, label: &str, route: Route, badge: Option<usize>) -> El {
    let t = crate::theme::tokens(dark);
    let active = section_of(&s.route) == label;
    el()
        .key(format!("nav:{label}"))
        .w_full()
        .h(36.0)
        .px(space::S3)
        .gap(space::S2)
        .center_y()
        .radius(9.0)
        .fill(if active { t.sidebar_wash(dark) } else { rune::Color::TRANSPARENT })
        .child(text(label.to_string()).font(if active { ty::UI_MED } else { ty::UI }).color(t.fg).grow(1.0))
        .children(badge.map(|n| badge_el(n, dark)))
        .focusable(true)
        .on_press(move |s: &mut App| s.route = route.clone())
}

pub fn badge_el(n: usize, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let word = if n == 0 { String::new() } else if n > 9 { "9+".into() } else { n.to_string() };
    el()
        .key("badge")
        .min_w(20.0)
        .h(20.0)
        .px(6.0)
        .radius(10.0)
        .fill(if n == 0 { Color::TRANSPARENT } else { t.signal })
        .center()
        .child(text(word).font(ty::META_MED).color(t.signal_fg))
}

fn crew_rows(s: &App, dark: bool) -> Vec<El> {
    if !s.has("profiles") {
        return vec![common::skeleton(200.0, 20.0, dark)];
    }
    s.visible_bots()
        .iter()
        .map(|p| {
            let t = crate::theme::tokens(dark);
            let id = p.id.clone();
            let selected = s.route == Route::Home && s.current_bot_id().as_deref() == Some(p.id.as_str());
            el()
                .key(format!("bot:{}", p.id))
                .w_full()
                .h(36.0)
                .px(space::S2)
                .gap(space::S2)
                .center_y()
                .radius(9.0)
                .fill(if selected { t.sidebar_wash(dark) } else { Color::TRANSPARENT })
                .child(common::bot_avatar(s, &p.id, 20.0, dark))
                .child(text(p.name.clone()).font(ty::UI).color(t.fg).max_lines(1).grow(1.0))
                .hover(t.wash(0.05))
                .focusable(true)
                .on_press(move |s: &mut App| {
                    s.last_bot = Some(id.clone());
                    s.route = Route::Home;
                })
        })
        .collect()
}

fn recents(s: &App, dark: bool) -> Vec<El> {
    if !s.has("sessions") {
        return vec![];
    }
    let mut chats: Vec<_> = s.sessions.iter().filter(|x| x.kind != "main" && x.kind != "room").collect();
    chats.sort_by(|a, b| b.last_message_at.partial_cmp(&a.last_message_at).unwrap_or(std::cmp::Ordering::Equal));
    chats
        .iter()
        .take(6)
        .map(|c| {
            let t = crate::theme::tokens(dark);
            let id = c.id.clone();
            el()
                .key(format!("recent:{}", c.id))
                .w_full()
                .h(32.0)
                .px(space::S2)
                .gap(space::S2)
                .center_y()
                .radius(9.0)
                .child(common::bot_avatar(s, &c.profile, 16.0, dark))
                .child(text(c.title.clone()).font(ty::META).color(t.muted_fg).max_lines(1).grow(1.0))
                .hover(t.wash(0.05))
                .focusable(true)
                .on_press(move |s: &mut App| s.route = Route::Chat(id.clone()))
        })
        .collect()
}

fn new_chat(s: &mut App) {
    let Some(bot) = s.current_bot_id() else { return };
    s.net.mutate(Mutation::NewChat(bot.clone()), &format!("new-chat:{bot}"));
    s.toast = Some("Starting a new chat…".into());
    s.toast_at = Some(common::now_millis());
}

fn open_switcher(s: &mut App) {
    s.switcher = Some(crate::state::Switcher { active: 0 });
}

/// `sectionOf(path)`: which of the four sections a route belongs to.
pub fn section_of(route: &Route) -> &'static str {
    match route {
        Route::Home | Route::Chat(_) | Route::History => "Chats",
        Route::Now => "Now",
        Route::Crew | Route::Profile(_, _) | Route::Team(_) => "Crew",
        Route::Settings => "Settings",
        Route::Routines | Route::Rooms | Route::Tools(_) => "Tools",
    }
}
