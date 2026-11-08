//! Shared UI pieces: the Page idiom, section headers, named-thing list rows,
//! skeletons, time words, and the bot characters (ported `lib/avatar.ts`).

use crate::state::App;
use rune::tok::{radius, space};
use rune::tok::motion;
use rune::{col, el, text, Cx, Color, El};

/// The chat and title sizes, above the kit's own scale (web `text-chat`/`text-title`).
pub use crate::theme::ty;

/// FNV-1a with a final avalanche, exactly `hashSeed` in `lib/avatar.ts`.
pub fn hash_seed(seed: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for ch in seed.chars() {
        hash ^= ch as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash ^= hash >> 16;
    hash = hash.wrapping_mul(0x85eb_ca6b);
    hash ^= hash >> 13;
    hash
}

#[derive(Clone, Copy)]
pub struct Character {
    pub body: u32,
    pub hue: usize,
}

/// `characterOf`: traits from bit slices of one 32-bit hash.
pub fn character_of(seed: &str) -> Character {
    let hash = hash_seed(seed.trim().to_lowercase().as_str());
    Character { body: hash & 3, hue: ((hash >> 8) % 6) as usize }
}

/// A bot's character body, `size` points, on the token hue for its id.
pub fn bot_avatar(_app: &App, profile_id: &str, size: f32, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let c = character_of(profile_id);
    let hue = t.char[c.hue];
    character_body(c.body, size, hue, t.char_ink)
}

fn character_body(shape: u32, size: f32, hue: Color, ink: Color) -> El {
    let eye = size * 0.075;
    let eye_y = size * 0.42;
    let (x1, x2) = (size * 0.34 - eye / 2.0, size * 0.66 - eye / 2.0);
    let (radius_pt, wide) = match shape {
        0 => (size * 0.5, (size * 0.82, size * 0.9)),
        1 => (size * 0.5, (size * 0.85, size * 0.85)),
        2 => (size * 0.3, (size * 0.85, size * 0.85)),
        _ => (size * 0.42, (size * 0.95, size * 0.8)),
    };
    let (w, h) = wide;
    el()
        .key("char")
        .size(size, size)
        .child(el().key("body").size(w, h).absolute((size - w) / 2.0, size - h).radius(radius_pt).fill(hue))
        .child(
            el()
                .key("eyes")
                .size(size, size)
                .absolute(0.0, 0.0)
                .child(el().key("e1").size(eye, eye * 1.4).absolute(x1, eye_y).radius(eye / 2.0).fill(ink))
                .child(el().key("e2").size(eye, eye * 1.4).absolute(x2, eye_y).radius(eye / 2.0).fill(ink)),
        )
}

/// Small muted label for section headers (`.section-label`).
pub fn section_label(words: &str, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    text(words.to_string()).font(ty::META_MED).color(t.muted_fg)
}

/// The one card-of-rows container: `rounded-xl` with `p-1` (named-thing lists).
pub fn list_card(dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    el().key("list").w_full().padding(space::S1).radius(15.0).fill(t.card).border(1.0, t.hairline)
}

/// One row inside a list card: a 56px two-line row that hovers and presses.
pub fn list_row(
    key: &str,
    label: String,
    detail: Option<String>,
    trailing: Option<El>,
    on_press: impl Fn(&mut App) + 'static,
) -> El {
    let (t1, t2) = (crate::theme::tokens(true).fg, crate::theme::tokens(true).muted_fg);
    let mut r = el()
        .key(format!("row:{key}"))
        .w_full()
        .min_h(56.0)
        .px(space::S3)
        .py(space::S2)
        .gap(space::S2)
        .center_y()
        .radius(radius::MD)
        .child(
            col()
                .key("lines")
                .gap(2.0)
                .min_w(0.0)
                .grow(1.0)
                .child(text(label).font(ty::UI_MED).color(t1).max_lines(1).grow(1.0))
                .children(detail.map(|d| text(d).font(ty::META).color(t2).max_lines(1))),
        );
    if let Some(tr) = trailing {
        r = r.child(tr);
    }
    r.hover(crate::theme::tokens(true).wash(0.05)).press(crate::theme::tokens(true).wash(0.08))
        .focusable(true)
        .on_press(on_press)
}

/// Loading placeholder bars (the web's skeleton).
pub fn skeleton(width: f32, height: f32, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    el().key("skeleton").w(width).h(height).radius(9.0).fill(t.muted)
}

/// A screen's title row through the `Page` idiom: title + actions beside it.
pub fn page_header(title: &str, dark: bool, actions: Vec<El>) -> El {
    let t = crate::theme::tokens(dark);
    let mut row = el()
        .key("page-head")
        .w_full()
        .pb(16.0)
        .gap(space::S3)
        .center_y()
        .child(text(title.to_string()).font(ty::TITLE).color(t.fg).grow(1.0));
    for a in actions {
        row = row.child(a);
    }
    row
}

/// A quiet word for empty and error states.
pub fn empty_state(words: &str, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    el()
        .key("empty")
        .w_full()
        .padding(space::S6)
        .center()
        .child(text(words.to_string()).font(ty::UI).color(t.muted_fg))
}

/// Relative time words (`lib/format.ts` spirit).
pub fn ago(at_ms: f64) -> String {
    let now = now_millis();
    let s = ((now - at_ms) / 1000.0).max(0.0);
    if s < 60.0 {
        "just now".into()
    } else if s < 3600.0 {
        format!("{}m", (s / 60.0) as u32)
    } else if s < 86_400.0 {
        format!("{}h", (s / 3600.0) as u32)
    } else {
        format!("{}d", (s / 86_400.0) as u32)
    }
}

pub fn now_millis() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// Human words for a byte count.
pub fn bytes_word(bytes: f64) -> String {
    if bytes < 1024.0 {
        format!("{} B", bytes as u32)
    } else if bytes < 1024.0 * 1024.0 {
        format!("{:.0} kB", bytes / 1024.0)
    } else {
        format!("{:.1} MB", bytes / (1024.0 * 1024.0))
    }
}

/// A hairline rule.
pub fn hairline(dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    el().key("hair").w_full().h(1.0).fill(t.hairline)
}

/// Cx helper: is the app dark right now, honoring the preference.
pub fn is_dark(s: &App, cx: &Cx<App>) -> bool {
    match s.theme {
        crate::state::ThemeMode::System => cx.system_dark(),
        crate::state::ThemeMode::Light => false,
        crate::state::ThemeMode::Dark => true,
    }
}

/// The rows' shared motion (the web's 120-200 ms world).
pub fn row_motion() -> rune::Spring {
    motion::SNAPPY
}
