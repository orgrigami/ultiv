//! The tool-call lens's expanded bodies: the shaped per-kind views
//! (`tool-bodies.tsx`) — search hits, HTTP round trips, terminal output,
//! files, records, pages, raw output, plain lines, and the quoted body with
//! its tags. Everything arrives already projected from `@spriessen/present`.

use crate::state::ChatMessage;
use crate::ui::common::ty;
use rune::tok::space;
use rune::{col, el, text, Color, El};

/// Whether the row has anything more to show (a chevron at all).
pub fn has_more(m: &ChatMessage) -> bool {
    let Some(view) = &m.view else { return m.error.is_some() };
    ["structured", "lines", "body", "tags"].iter().any(|k| view.get(k).is_some()) || m.error.is_some()
}

/// The expanded body of one tool row: error note first, then the shaped view.
pub fn body(s: &crate::state::App, m: &ChatMessage, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let mut parts: Vec<El> = Vec::new();
    if let Some(error) = &m.error {
        parts.push(
            el()
                .key("error-note")
                .w_full()
                .padding(space::S2)
                .radius(9.0)
                .fill(t.deny.alpha(0.12))
                .child(text(error.clone()).font(ty::MONO).color(t.deny)),
        );
    }
    if let Some(view) = &m.view {
        if let Some(lines) = view.get("lines").and_then(serde_json::Value::as_array) {
            parts.push(lines_block(lines, dark));
        }
        match view.get("structured") {
            Some(b) => parts.push(structured(s, b, dark)),
            None => {
                if let Some(body_words) = view.get("body").and_then(serde_json::Value::as_str) {
                    parts.push(quote(body_words, dark));
                }
            }
        }
        if let Some(tags) = view.get("tags").and_then(serde_json::Value::as_array) {
            let words: Vec<String> = tags.iter().filter_map(serde_json::Value::as_str).map(String::from).collect();
            if !words.is_empty() {
                parts.push(
                    rune::row()
                        .key("tags")
                        .gap(space::S1)
                        .children(words.into_iter().map(|w| {
                            el()
                                .key(format!("tag:{w}"))
                                .px(8.0)
                                .py(2.0)
                                .radius(10.0)
                                .fill(t.muted)
                                .child(text(w).font(ty::META).color(t.muted_fg))
                        })),
                );
            }
        }
    }
    col().key("lens-body").gap(space::S2).children(parts)
}

fn quote(words: &str, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    el()
        .key("body-quote")
        .w_full()
        .pl(space::S3)
        .border(2.0, t.hairline)
        .child(text(words.to_string()).font(ty::UI).color(t.fg).max_lines(14))
}

fn lines_block(lines: &[serde_json::Value], dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    col().key("lines").gap(space::S1).children(
        lines
            .iter()
            .enumerate()
            .map(|(i, line)| {
                text(line.as_str().unwrap_or("").to_string())
                    .key(format!("line:{i}"))
                    .font(ty::MONO)
                    .color(t.fg)
                    .max_lines(2)
            })
            .collect::<Vec<_>>(),
    )
}

/// The shaped body per kind (`ToolBodyData`).
fn structured(s: &crate::state::App, body: &serde_json::Value, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let kind = body.get("t").and_then(serde_json::Value::as_str).unwrap_or("");
    match kind {
        "search" => search_body(body, dark),
        "term" => code_plate(
            dark,
            body.get("command").and_then(serde_json::Value::as_str).unwrap_or(""),
            body.get("output").and_then(serde_json::Value::as_str).unwrap_or(""),
        ),
        "file" => code_plate(
            dark,
            body.get("name").and_then(serde_json::Value::as_str).unwrap_or(""),
            body.get("text").and_then(serde_json::Value::as_str).unwrap_or(""),
        ),
        "http" => http_body(body, dark),
        "record" => record_body(body, dark),
        "page" => {
            let host = body.get("host").and_then(serde_json::Value::as_str).unwrap_or("");
            let words = body.get("text").and_then(serde_json::Value::as_str).unwrap_or("");
            col()
                .key("page-body")
                .gap(space::S1)
                .child(text(host.to_string()).font(ty::MONO).color(t.muted_fg).max_lines(1))
                .child(text(words.to_string()).font(ty::UI).color(t.fg).max_lines(20))
        }
        "output" => code_plate(dark, "", body.get("text").and_then(serde_json::Value::as_str).unwrap_or("")),
        _ => {
            let _ = s;
            common_empty(dark)
        }
    }
}

fn common_empty(dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    text("(nothing to show)".to_string()).font(ty::META).color(t.muted_fg)
}

/// Search: the query, then each hit's title (link-colored), site and snippet.
fn search_body(body: &serde_json::Value, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let query = body.get("query").and_then(serde_json::Value::as_str).unwrap_or("");
    let mut rows: Vec<El> = vec![text(format!("Search: {query}")).font(ty::UI_MED).color(t.fg).max_lines(1)];
    if let Some(hits) = body.get("hits").and_then(serde_json::Value::as_array) {
        for (i, hit) in hits.iter().take(8).enumerate() {
            let title = hit.get("title").and_then(serde_json::Value::as_str).unwrap_or("A hit");
            let site = hit.get("site").and_then(serde_json::Value::as_str).unwrap_or("");
            let snippet = hit.get("snippet").and_then(serde_json::Value::as_str).unwrap_or("");
            rows.push(
                col()
                    .key(format!("hit:{i}"))
                    .gap(2.0)
                    .child(
                        rune::row()
                            .key(format!("hit-head:{i}"))
                            .gap(space::S2)
                            .child(text(title.to_string()).font(ty::UI_MED).color(t.live).max_lines(1).grow(1.0))
                            .children((!site.is_empty()).then(|| text(site.to_string()).font(ty::META).color(t.muted_fg))),
                    )
                    .children((!snippet.is_empty()).then(|| text(snippet.to_string()).font(ty::META).color(t.muted_fg).max_lines(2))),
            );
        }
    }
    col().key("search-body").gap(space::S2).children(rows)
}

/// HTTP: the request line, the status, then Sent / Got back blocks.
fn http_body(body: &serde_json::Value, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let method = body.get("method").and_then(serde_json::Value::as_str).unwrap_or("GET");
    let url = body.get("url").and_then(serde_json::Value::as_str).unwrap_or("");
    let status = body.get("status").and_then(serde_json::Value::as_f64);
    let sent = body.get("sent").and_then(serde_json::Value::as_str);
    let got = body.get("got").and_then(serde_json::Value::as_str);
    let mut parts = vec![text(format!("{method} {url}")).font(ty::MONO).color(t.fg).max_lines(2)];
    if let Some(code) = status {
        parts.push(text(format!("Status {code}")).font(ty::META_MED).color(t.muted_fg));
    }
    if let Some(sent) = sent {
        parts.push(block("Sent", sent, dark));
    }
    if let Some(got) = got {
        parts.push(block("Got back", got, dark));
    }
    col().key("http-body").gap(space::S2).children(parts)
}

fn record_body(body: &serde_json::Value, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let mut rows: Vec<El> = Vec::new();
    if let Some(fields) = body.get("fields").and_then(serde_json::Value::as_array) {
        for (i, field) in fields.iter().enumerate() {
            let k = field.get("k").and_then(serde_json::Value::as_str).unwrap_or("");
            let v = field.get("v").and_then(serde_json::Value::as_str).unwrap_or("");
            let mono = field.get("mono").and_then(serde_json::Value::as_bool).unwrap_or(false);
            let value = if mono { text(v.to_string()).font(ty::MONO).color(t.fg) } else { text(v.to_string()).font(ty::UI).color(t.fg) };
            rows.push(
                rune::row()
                    .key(format!("field:{i}"))
                    .gap(space::S3)
                    .child(text(k.to_string()).font(ty::META).color(t.muted_fg).w(110.0))
                    .child(value.max_lines(2).grow(1.0)),
            );
        }
    }
    if let Some(note) = body.get("note").and_then(serde_json::Value::as_str) {
        rows.push(text(note.to_string()).font(ty::META).color(t.muted_fg).max_lines(2));
    }
    col().key("record-body").gap(space::S1).children(rows)
}

/// The terminal/file plate: the command or name as its label, the body mono.
fn code_plate(dark: bool, label: &str, words: &str) -> El {
    let t = crate::theme::tokens(dark);
    let mut card = col()
        .key("code-plate")
        .w_full()
        .padding(space::S3)
        .gap(space::S1)
        .radius(10.0)
        .fill(t.muted)
        .border(1.0, t.hairline);
    if !label.is_empty() {
        card = card.child(text(label.to_string()).font(ty::MONO_MED).color(t.live).max_lines(1));
    }
    card = card.child(text(words.to_string()).font(ty::MONO).color(t.fg).max_lines(24));
    card
}

fn block(label: &str, words: &str, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    col()
        .key(format!("block:{label}"))
        .gap(space::S1)
        .child(text(label.to_string()).font(ty::META_MED).color(t.muted_fg))
        .child(
            el()
                .key(format!("block-words:{label}"))
                .w_full()
                .padding(space::S2)
                .radius(9.0)
                .fill(t.muted)
                .border(1.0, t.hairline)
                .child(text(words.to_string()).font(ty::MONO).color(t.fg).max_lines(16)),
        )
}

/// Unused today; the record values color through the tokens' own palette.
#[allow(dead_code)]
fn ink(dark: bool) -> Color {
    crate::theme::tokens(dark).fg
}
