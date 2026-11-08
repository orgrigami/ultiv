//! `/rooms`, Bot talks: the room list, the room view with the owner's
//! composer, and the merged speaker-labelled timeline.

use crate::net::endpoints::{Fetch, Mutation};
use crate::state::App;
use crate::ui::common::{self, ty};
use rune::tok::space;
use rune::{col, el, text, El};
use rune_kit::TextArea;

pub fn view(s: &App, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let k = crate::theme::kit(dark);
    let list = if !s.has("rooms") {
        common::list_card(dark).child(common::skeleton(280.0, 40.0, dark))
    } else if s.rooms.is_empty() {
        common::list_card(dark).child(common::empty_state("No talks yet.", dark))
    } else {
        common::list_card(dark).children(
            s.rooms
                .iter()
                .map(|r| {
                    let id = crate::net::types::row_str(r, "id");
                    let name = crate::net::types::row_str(r, "name");
                    let room_id = id.clone();
                    common::list_row(
                        &id,
                        if name.is_empty() { "A talk".to_string() } else { name },
                        None,
                        None,
                        move |s: &mut App| s.net.fetch(Fetch::Room(room_id.clone())),
                    )
                })
                .collect::<Vec<_>>(),
        )
    };
    let room_view = s.room.as_ref().map(|detail| room_body(s, detail, dark, &k));
    let composer = room_view.is_some().then(|| {
        TextArea::new(&s.room_draft)
            .placeholder("Speak as yourself")
            .on_edit(|s: &mut App| &mut s.room_draft)
            .on_submit(|s: &mut App, _| send(s))
            .build(&k)
    });
    let mut page = col()
        .key("rooms-page")
        .w_full()
        .padding(space::S6)
        .gap(16.0)
        .child(common::page_header("Bot talks", dark, vec![]))
        .child(list);
    if let Some(rv) = room_view {
        page = page.child(rv);
    }
    if let Some(c) = composer {
        page = page.child(c);
    }
    el()
        .key("rooms")
        .w_full()
        .h_full()
        .fill(t.background)
        .child(
            el()
                .key("rooms-scroll")
                .w_full()
                .h_full()
                .min_h(0.0)
                .scroll(rune::ScrollSpec { stick_bottom: false })
                .child(page),
        )
}

fn room_body(_s: &App, detail: &crate::net::types::Row, dark: bool, _k: &rune_kit::Kit) -> El {
    let t = crate::theme::tokens(dark);
    let timeline = detail.get("timeline").and_then(serde_json::Value::as_array).cloned().unwrap_or_default();
    let rows: Vec<El> = timeline
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let from = crate::net::types::row_str(m, "from");
            let speaker = if from.is_empty() { crate::net::types::row_str(m, "speaker") } else { from };
            let words = crate::net::types::row_str(m, "text");
            el()
                .key(format!("room-msg:{i}"))
                .w_full()
                .px(space::S3)
                .py(space::S2)
                .gap(space::S1)
                .child(text(speaker).font(ty::META_MED).color(t.live))
                .child(text(words).font(ty::UI).color(t.fg).max_lines(12))
        })
        .collect();
    col().key("room").gap(space::S3).child(common::list_card(dark).children(rows))
}

fn send(s: &mut App) {
    let Some(detail) = s.room.clone() else { return };
    let Some(id) = detail.get("room").and_then(|r| r.get("id")).and_then(serde_json::Value::as_str).map(String::from) else {
        return;
    };
    let text_msg = s.room_draft.text.clone();
    if text_msg.trim().is_empty() {
        return;
    }
    s.room_draft = rune::TextEdit::new(String::new());
    s.net.mutate(Mutation::Say { room: id.clone(), text: text_msg, to: None }, &format!("say:{id}"));
    s.net.fetch(Fetch::Room(id));
}
