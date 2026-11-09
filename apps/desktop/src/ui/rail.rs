//! The sidebar rail, matching the web's: the brand wordmark, New chat and
//! Find rows with their shortcut hints, the four icon destinations, the crew
//! roster, Recent (two-line rows), All past chats, and Settings at the bottom.

use crate::state::{App, Route};
use crate::ui::common::{self, ty};
use crate::ui::icons;
use rune::tok::space;
use rune::{col, el, icon, text, Color, El};

/// The whole rail, 256 points, with the traffic lights' band cleared.
pub fn view(s: &App, dark: bool, top_inset: f32) -> El {
    let t = crate::theme::tokens(dark);
    col()
        .key("rail")
        .w(256.0)
        .h_full()
        .fill(t.sidebar)
        .border(1.0, t.hairline)
        .pt(top_inset)
        .pb(space::S2)
        .px(space::S2)
        .child(wordmark(s, dark))
        .child(row_button(s, dark, "New chat", &icons::SQUARE_PEN, Some("N"), Route::Home, None))
        .child(row_button(s, dark, "Find", &icons::SEARCH, Some("⌘K"), Route::Home, Some(open_switcher)))
        .child(nav_row(s, dark, "Now", &icons::BELL_DOT, Route::Now, badge(s, dark)))
        .child(nav_row(s, dark, "Chats", &icons::MESSAGE, Route::Home, None))
        .child(nav_row(s, dark, "Crew", &icons::USERS, Route::Crew, None))
        .child(section_label("Crew", dark))
        .children(crew_rows(s, dark))
        .child(
            el()
                .key("rail-scroll")
                .grow(1.0)
                .min_h(0.0)
                .child(
                    col()
                        .key("recents")
                        .child(section_label("Recent", dark))
                        .children(recents(s, dark))
                        .child(
                            el()
                                .key("all-past")
                                .px(space::S3)
                                .py(space::S1)
                                .child(text("All past chats".to_string()).font(ty::META).color(t.muted_fg))
                                .focusable(true)
                                .on_press(|s: &mut App| s.route = Route::History),
                        ),
                ),
        )
        .child(
            el()
                .key("rail-foot")
                .px(space::S1)
                .child(
                    el()
                        .key("settings-row")
                        .w_full()
                        .h(40.0)
                        .px(space::S2)
                        .gap(space::S2)
                        .center_y()
                        .radius(9.0)
                        .gap(space::S2)
                        .child(icon(&icons::GEAR, 20.0).color(t.fg))
                        .child(text("Settings".to_string()).font(ty::UI).color(t.fg))
                        .hover(t.wash(0.05))
                        .focusable(true)
                        .on_press(|s: &mut App| s.route = Route::Settings),
                ),
        )
}

/// The wordmark: the brand mark (an amber gumdrop with two eyes and a
/// sprout, `MARK` in brand.ts) beside the lowercase name.
fn wordmark(_s: &App, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let size = 26.0;
    let body = common::character_body(0, size, t.brand_amber, t.brand_ink);
    el()
        .key("wordmark")
        .w_full()
        .px(space::S2)
        .py(space::S2)
        .gap(space::S2)
        .center_y()
        .child(el().key("mark").size(size, size).child(body))
        .child(text("spriessen".to_string()).font(ty::UI_MED).color(t.fg))
}

/// A rail row: leading icon, label, optional trailing shortcut word.
#[allow(clippy::too_many_arguments)]
fn row_button(
    _s: &App,
    dark: bool,
    label: &str,
    icon_ref: &'static rune::Icon,
    shortcut: Option<&'static str>,
    route: Route,
    action: Option<fn(&mut App)>,
) -> El {
    let t = crate::theme::tokens(dark);
    let mut r = el()
        .key(format!("row:{label}"))
        .w_full()
        .h(40.0)
        .px(space::S2)
        .gap(space::S2)
        .center_y()
        .radius(9.0)
        .child(icon(icon_ref, 20.0).color(t.fg))
        .child(text(label.to_string()).font(ty::UI_MED).color(t.fg).grow(1.0))
        .children(shortcut.map(|k| text(k.to_string()).font(ty::META).color(t.muted_fg)))
        .hover(t.wash(0.05))
        .focusable(true);
    if let Some(action) = action {
        r = r.on_press(move |s: &mut App| action(s));
    } else {
        let route = route.clone();
        r = r.on_press(move |s: &mut App| s.route = route.clone());
    }
    r
}

fn nav_row(s: &App, dark: bool, label: &str, icon_ref: &'static rune::Icon, route: Route, badge: Option<El>) -> El {
    let t = crate::theme::tokens(dark);
    let active = section_of(&s.route) == label;
    let route_for = route.clone();
    el()
        .key(format!("nav:{label}"))
        .w_full()
        .h(40.0)
        .px(space::S2)
        .gap(space::S2)
        .center_y()
        .radius(9.0)
        .fill(if active { t.sidebar_wash(dark) } else { Color::TRANSPARENT })
        .child(icon(icon_ref, 20.0).color(t.fg))
        .child(text(label.to_string()).font(if active { ty::UI_MED } else { ty::UI }).color(t.fg).grow(1.0))
        .children(badge)
        .hover(t.wash(0.05))
        .focusable(true)
        .on_press(move |s: &mut App| s.route = route_for.clone())
}

fn badge(s: &App, dark: bool) -> Option<El> {
    let n = s.needs_count();
    (n > 0).then(|| rail_badge(n, dark))
}

fn section_label(words: &str, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    el()
        .key(format!("lbl:{words}"))
        .w_full()
        .pt(space::S3)
        .pb(space::S1)
        .px(space::S3)
        .child(text(words.to_string()).font(ty::META_MED).color(t.muted_fg))
}

pub fn rail_badge(n: usize, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let word = if n > 9 { "9+".to_string() } else { n.to_string() };
    el()
        .key("badge")
        .min_w(20.0)
        .h(20.0)
        .px(6.0)
        .radius(10.0)
        .fill(t.signal)
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
                .h(40.0)
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

/// Recent: two-line rows (title, then "bot · time"), "Untitled chat" when
/// the bot never named it.
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
            let title = if c.title.trim().is_empty() { "Untitled chat".to_string() } else { c.title.clone() };
            let detail = format!("{} · {}", s.bot_name(&c.profile), common::ago(c.last_message_at));
            el()
                .key(format!("recent:{}", c.id))
                .w_full()
                .px(space::S3)
                .py(space::S1)
                .gap(space::S1)
                .radius(9.0)
                .child(text(title).font(ty::UI).color(t.fg).max_lines(1))
                .child(text(detail).font(ty::META).color(t.muted_fg).max_lines(1))
                .hover(t.wash(0.05))
                .focusable(true)
                .on_press(move |s: &mut App| s.route = Route::Chat(id.clone()))
        })
        .collect()
}

fn open_switcher(s: &mut App) {
    s.switcher_edit = rune::TextEdit::new(String::new());
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
