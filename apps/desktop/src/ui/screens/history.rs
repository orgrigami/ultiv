//! `/history`: past chats, whose filter also searches the words said.

use crate::state::App;
use crate::ui::common::{self, ty};
use rune::tok::space;
use rune::{col, el, text, El};
use rune_kit::TextInput;

pub fn view(s: &App, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let k = crate::theme::kit(dark);
    let filter = TextInput::new(&s.history_query)
        .placeholder("Search chats and words said")
        .on_edit(|s: &mut App| &mut s.history_query)
        .on_submit(|s: &mut App, _| {
            let q = s.history_query.text.clone();
            s.net.fetch(crate::net::endpoints::Fetch::History(q));
        })
        .build(&k);
    let mut card = common::list_card(dark).key("history-list");
    if !s.has("sessions") {
        card = card.child(common::skeleton(320.0, 56.0, dark));
    } else {
        let mut chats: Vec<_> = s.sessions.iter().filter(|x| x.kind != "main" && x.kind != "room").collect();
        chats.sort_by(|a, b| b.last_message_at.partial_cmp(&a.last_message_at).unwrap_or(std::cmp::Ordering::Equal));
        let rows: Vec<El> = chats
            .iter()
            .map(|c| {
                let t2 = crate::theme::tokens(dark);
                let id = c.id.clone();
                common::list_row(
                    &c.id,
                    c.title.clone(),
                    Some(common::ago(c.last_message_at)),
                    Some(common::bot_avatar(s, &c.profile, 20.0, dark)),
                    move |s: &mut App| s.route = crate::state::Route::Chat(id.clone()),
                )
                .hover(t2.wash(0.04))
            })
            .collect();
        card = if rows.is_empty() {
            card.child(common::empty_state("No past chats.", dark))
        } else {
            card.children(rows)
        };
    }
    let messages = s.message_search.as_ref().map(|groups| {
        let t2 = crate::theme::tokens(dark);
        col()
            .key("messages")
            .gap(space::S2)
            .child(common::section_label("Messages", dark))
            .child(
                common::list_card(dark).children(
                    groups
                        .iter()
                        .take(20)
                        .enumerate()
                        .map(|(i, g)| {
                            let snippet = g
                                .get("hits")
                                .and_then(|h| h.as_array())
                                .and_then(|h| h.first())
                                .and_then(|h| h.get("text"))
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("");
                            el()
                                .key(format!("msg:{i}"))
                                .w_full()
                                .min_h(44.0)
                                .px(space::S3)
                                .py(space::S2)
                                .child(text(snippet.to_string()).font(ty::UI).color(t2.fg).max_lines(2))
                        })
                        .collect::<Vec<_>>(),
                ),
            )
    });
    let mut page = col()
        .key("history-page")
        .w_full()
        .padding(space::S6)
        .gap(16.0)
        .child(common::page_header("Past chats", dark, vec![]))
        .child(filter)
        .child(card);
    if let Some(m) = messages {
        page = page.child(m);
    }
    el()
        .key("history")
        .w_full()
        .h_full()
        .fill(t.background)
        .child(
            el()
                .key("history-scroll")
                .w_full()
                .h_full()
                .min_h(0.0)
                .scroll(rune::ScrollSpec { stick_bottom: false })
                .child(page),
        )
}
