//! `/crew`: the bot list plus links to all routines, bot talks, past chats.

use crate::state::{App, Route};
use crate::ui::common::{self};
use rune::tok::space;
use rune::{col, el, El};
use rune_kit::{Button, ButtonVariant};

pub fn view(s: &App, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let k = crate::theme::kit(dark);
    let new_bot = Button::new("New bot").variant(ButtonVariant::Outline).on_press(|_: &mut App| {}).build(&k);
    let mut card = common::list_card(dark).key("crew-list");
    if !s.has("profiles") {
        card = card.child(common::skeleton(320.0, 56.0, dark));
    } else if s.visible_bots().is_empty() {
        card = card.child(common::empty_state("No bots yet. Make the first one.", dark));
    } else {
        let bots = s.visible_bots();
        let rows = bots.iter().map(|p| {
            let id = p.id.clone();
            let model = p.model.as_ref().map(|m| m.id.clone()).unwrap_or_default();
            let description = if p.description.is_empty() { model } else { p.description.clone() };
            common::list_row(
                &p.id,
                p.name.clone(),
                Some(description),
                Some(common::bot_avatar(s, &p.id, 24.0, dark)),
                move |s: &mut App| {
                    s.route = Route::Profile(id.clone(), crate::state::ProfileTab::Overview);
                },
            )
            .hover(t.wash(0.04))
        });
        card = card.children(rows.collect::<Vec<_>>());
    }
    let links = rune::row()
        .key("crew-links")
        .gap(space::S2)
        .child(Button::new("Routines").variant(ButtonVariant::Ghost).on_press(|s: &mut App| s.route = Route::Routines).build(&k))
        .child(Button::new("Bot talks").variant(ButtonVariant::Ghost).on_press(|s: &mut App| s.route = Route::Rooms).build(&k))
        .child(Button::new("Past chats").variant(ButtonVariant::Ghost).on_press(|s: &mut App| s.route = Route::History).build(&k));
    el()
        .key("crew")
        .w_full()
        .h_full()
        .fill(t.background)
        .child(
            el()
                .key("crew-scroll")
                .w_full()
                .h_full()
                .min_h(0.0)
                .scroll(rune::ScrollSpec { stick_bottom: false })
                .child(
                    col()
                        .key("crew-page")
                        .w_full()
                        .padding(space::S6)
                        .gap(16.0)
                        .child(common::page_header("Crew", dark, vec![new_bot]))
                        .child(card)
                        .child(links),
                ),
        )
}
