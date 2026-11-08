//! The chat screen: the current bot's live transcript over the chord bridge
//! (the Node sidecar in `sidecar/`), the floating composer beneath it, and
//! the header's bot switcher. The transcript shows the bridge's words until
//! the session attaches, then the real one, exactly the web's structure.

use crate::state::App;
use crate::ui::common::{self, ty};
use rune::tok::space;
use rune::{col, el, text, El};
use rune_kit::{Button, ButtonVariant, TextArea};

pub fn view(s: &App, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let k = crate::theme::kit(dark);
    let Some(bot) = s.current_bot() else { return col().key("chat-empty") };
    let header = el()
        .key("chat-head")
        .w_full()
        .px(16.0)
        .py(space::S3)
        .gap(space::S2)
        .center_y()
        .child(common::bot_avatar(s, &bot.id, 24.0, dark))
        .child(text(bot.name.clone()).font(ty::UI_MED).color(t.fg))
        .child(approval_chip(s, dark, &k))
        .child(el().key("head-space").grow(1.0))
        .children(stop_button(s, &k))
        .child(Button::new("New chat").variant(ButtonVariant::Ghost).on_press(|s: &mut App| {
            if let Some(id) = s.current_bot_id() {
                let tag = format!("new-chat:{id}");
                s.net.mutate(crate::net::endpoints::Mutation::NewChat(id.clone()), &tag);
            }
        }).build(&k));
    let transcript = el()
        .key("transcript")
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .padding(16.0)
        .scroll(rune::ScrollSpec { stick_bottom: true })
        .child(
            col()
                .key("transcript-body")
                .w_full()
                .gap(space::S3)
                .children(transcript_rows(s, dark))
                .children(pending_card(s, dark, &k)),
        );
    let composer = composer(s, dark, &k);
    col()
        .key("chat")
        .w_full()
        .h_full()
        .min_h(0.0)
        .fill(t.background)
        .child(header)
        .child(common::hairline(dark))
        .child(transcript)
        .child(composer)
}

/// Stop while the bot works: the header's working state.
fn stop_button(s: &App, k: &rune_kit::Kit) -> Option<El> {
    if s.chat_phase != "working" {
        return None;
    }
    Some(
        Button::new("Stop")
            .variant(ButtonVariant::Outline)
            .on_press(|s: &mut App| {
                let Some(session) = s.chat_session.clone() else { return };
                s.bridge.interrupt(&session);
            })
            .build(k),
    )
}

/// The chat's own gated call, as a decision card at the transcript's end:
/// "<who> wants to <action>", the reason, then Deny / Approve / Always allow.
fn pending_card(s: &App, dark: bool, k: &rune_kit::Kit) -> Vec<El> {
    let Some(pending) = &s.chat_pending else { return vec![] };
    let t = crate::theme::tokens(dark);
    let call = pending.get("callId").and_then(serde_json::Value::as_str).unwrap_or("").to_string();
    if call.is_empty() {
        return vec![];
    }
    let name = pending.get("name").and_then(serde_json::Value::as_str).unwrap_or("a tool");
    let who = s.current_bot().map(|b| b.name.clone()).unwrap_or_else(|| "The bot".into());
    let reason = pending.get("reason").and_then(serde_json::Value::as_str);
    let risky = pending.get("risky").and_then(serde_json::Value::as_bool).unwrap_or(false);
    let edge = if risky { t.signal } else { t.hairline };
    let deny_call = call.clone();
    let approve_call = call.clone();
    vec![
        col()
            .key("pending-card")
            .w_full()
            .padding(space::S3)
            .gap(space::S2)
            .radius(15.0)
            .fill(t.card)
            .border(1.0, edge)
            .child(
                rune::row()
                    .key("pending-head")
                    .gap(space::S2)
                    .center_y()
                    .child(el().key("mark").size(8.0, 8.0).radius(4.0).fill(if risky { t.signal } else { t.live }))
                    .child(
                        text(format!("{who} wants to {}", crate::ui::screens::now::tool_words(name)))
                            .font(ty::UI_MED)
                            .color(t.fg),
                    ),
            )
            .children(reason.map(|r| {
                el()
                    .key("pending-reason")
                    .w_full()
                    .pl(space::S3)
                    .border(2.0, t.hairline)
                    .child(text(r.to_string()).font(ty::UI).color(t.muted_fg))
            }))
            .child(
                rune::row()
                    .key("pending-actions")
                    .gap(space::S2)
                    .child(
                        Button::new("Deny").variant(ButtonVariant::Outline).on_press(move |s: &mut App| {
                            decide_here(s, deny_call.clone(), false, false);
                        }).build(k),
                    )
                    .child(
                        Button::new("Approve").variant(ButtonVariant::Submit).on_press(move |s: &mut App| {
                            decide_here(s, approve_call.clone(), true, false);
                        }).build(k),
                    )
                    .child(
                        Button::new("Always allow").variant(ButtonVariant::Ghost).on_press(move |s: &mut App| {
                            decide_here(s, call.clone(), true, true);
                        }).build(k),
                    ),
            ),
    ]
}

fn decide_here(s: &mut App, call: String, approved: bool, always: bool) {
    let Some(session) = s.chat_session.clone() else { return };
    s.bridge.decide(&session, &call, approved, always);
}

fn approval_chip(s: &App, dark: bool, _k: &rune_kit::Kit) -> El {
    if s.approvals.is_empty() {
        return el().key("no-chip");
    }
    let t = crate::theme::tokens(dark);
    el()
        .key("approval-chip")
        .px(10.0)
        .py(4.0)
        .radius(999.0)
        .fill(t.signal.alpha(0.14))
        .child(text(format!("{} need{}", s.approvals.len(), plural(s.approvals.len()))).font(ty::META_MED).color(t.signal))
}

fn plural(n: usize) -> &'static str {
    if n == 1 { "s you" } else { "s you" }
}

fn transcript_rows(s: &App, dark: bool) -> Vec<El> {
    let _t = crate::theme::tokens(dark);
    let bridge_word = if s.chat_live { "" } else { "The chat bridge is connecting…" };
    let mut rows: Vec<El> = Vec::new();
    if !bridge_word.is_empty() {
        rows.push(common::empty_state(bridge_word, dark));
    }
    for (i, m) in s.chat.iter().enumerate() {
        let key = format!("msg:{i}");
        match m.role.as_str() {
            "user" | "owner" => rows.push(owner_row(key, m, dark)),
            "tool" => rows.push(tool_row(key, m, dark)),
            "note" | "thinking" => rows.push(quiet_row(key, m, dark)),
            _ => rows.push(bot_row(key, m, dark)),
        }
    }
    rows
}

fn owner_row(key: String, m: &crate::state::ChatMessage, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    el().key(key).w_full().child(
        el()
            .key("owner-card")
            .max_w(560.0)
            .ml(24.0)
            .padding(space::S3)
            .radius(20.0)
            .fill(t.muted.alpha(0.7))
            .child(text(m.text.clone()).font(ty::CHAT).color(t.fg)),
    )
}

fn bot_row(key: String, m: &crate::state::ChatMessage, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    el().key(key).w_full().child(
        col()
            .key("bot-prose")
            .gap(space::S1)
            .child(text(m.text.clone()).font(ty::CHAT).color(t.fg))
            .children(m.streaming.then(|| text("▍".to_string()).font(ty::CHAT).color(t.live))),
    )
}

/// A tool row through the lens: the working mark or the family dot, the
/// owner-worded title, its detail, and a tabular duration past 3 s.
fn tool_row(key: String, m: &crate::state::ChatMessage, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let dot = if m.streaming { t.live } else { t.success };
    rune::row()
        .key(key)
        .w_full()
        .gap(space::S2)
        .center_y()
        .child(el().key("mark").size(8.0, 8.0).radius(4.0).fill(dot))
        .child(text(m.text.clone()).font(ty::UI_MED).color(t.fg).max_lines(1))
        .children(m.detail.clone().map(|d| {
            text(d).font(ty::META).color(t.muted_fg).max_lines(1).grow(1.0)
        }))
        .children(m.duration.clone().map(|d| text(d).font(ty::MONO).color(t.muted_fg)))
}

/// The quiet lines: thinking and progress notes.
fn quiet_row(key: String, m: &crate::state::ChatMessage, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    el().key(key).w_full().child(
        text(m.text.clone()).font(ty::META).color(t.muted_fg).max_lines(6),
    )
}

fn composer(s: &App, dark: bool, k: &rune_kit::Kit) -> El {
    let t = crate::theme::tokens(dark);
    let who = s.current_bot().map(|b| b.name.clone()).unwrap_or_else(|| "the bot".into());
    rune::row()
        .key("composer")
        .w_full()
        .px(16.0)
        .pb(16.0)
        .gap(space::S2)
        .child(
            el()
                .key("composer-card")
                .grow(1.0)
                .padding(space::S2)
                .radius(25.0)
                .fill(t.card)
                .border(1.0, t.hairline)
                .child(
                    TextArea::new(&s.chat_draft)
                        .placeholder(format!("Ask {who}"))
                        .on_edit(|s: &mut App| &mut s.chat_draft)
                        .on_submit(|s: &mut App, _| send_chat(s))
                        .build(k),
                ),
        )
        .child(Button::new("Send").variant(ButtonVariant::Submit).on_press(|s: &mut App| send_chat(s)).build(k))
}

fn send_chat(s: &mut App) {
    let words = s.chat_draft.text.clone();
    let Some(session) = s.chat_session.clone() else { return };
    if words.trim().is_empty() {
        return;
    }
    s.bridge.input(&session, &words);
    s.chat_draft = rune::TextEdit::new(String::new());
}

