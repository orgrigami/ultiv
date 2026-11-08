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
    let teams = teams_section(s, dark, &k);
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
                        .child(teams)
                        .child(links),
                ),
        )
}

/// Across teams: the org's teams as rows into their pages, and the New team
/// row (a name + Create).
fn teams_section(s: &App, dark: bool, k: &rune_kit::Kit) -> El {
    let _t = crate::theme::tokens(dark);
    let teams = s.org.as_ref().and_then(|o| o.get("teams")).and_then(serde_json::Value::as_array).cloned().unwrap_or_default();
    let mut rows: Vec<El> = teams
        .iter()
        .map(|team| {
            let id = crate::net::types::row_str(team, "id");
            let name = crate::net::types::row_str(team, "name");
            let team_id = id.clone();
            common::list_row(
                &id,
                if name.is_empty() { "A team".to_string() } else { name },
                Some("open its page".into()),
                None,
                move |s: &mut App| s.route = Route::Team(team_id.clone()),
            )
        })
        .collect();
    if rows.is_empty() {
        rows.push(common::empty_state("No teams yet; every bot answers to the org.", dark));
    }
    let create_name = &s.team_name;
    let create = rune::row()
        .key("new-team")
        .gap(space::S2)
        .child(
            rune_kit::TextInput::new(create_name)
                .placeholder("A new team's name")
                .on_edit(|s: &mut App| &mut s.team_name)
                .on_submit(|s: &mut App, _| crate::ui::screens::crew::create_team(s))
                .build(k),
        )
        .child(Button::new("New team").variant(ButtonVariant::Outline).on_press(|s: &mut App| create_team(s)).build(k));
    col()
        .key("teams")
        .gap(space::S2)
        .child(common::section_label("Teams", dark))
        .child(common::list_card(dark).children(rows))
        .child(create)
}

fn create_team(s: &mut App) {
    let name = s.team_name.text.trim().to_string();
    if name.is_empty() {
        return;
    }
    s.team_name = rune::TextEdit::new(String::new());
    s.net.mutate(crate::net::endpoints::Mutation::CreateTeam(name.clone()), &format!("create-team:{name}"));
}
