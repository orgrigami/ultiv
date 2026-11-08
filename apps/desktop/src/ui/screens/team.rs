//! `/crew/team/:id`: the team's bots, settings, memory and templates.

use crate::state::App;
use crate::ui::common::{self, ty};
use rune::tok::space;
use rune::{col, el, text, El};

pub fn view(s: &App, team_id: &str, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let k = crate::theme::kit(dark);
    let teams = s.org.as_ref().and_then(|o| o.get("teams")).and_then(serde_json::Value::as_array).cloned().unwrap_or_default();
    let team = teams.iter().find(|tm| crate::net::types::row_str(tm, "id") == team_id);
    let name = team.map(|tm| crate::net::types::row_str(tm, "name")).unwrap_or_else(|| "A team".into());
    let members: Vec<El> = s
        .profiles
        .iter()
        .filter(|p| p.team_id.as_deref() == Some(team_id))
        .map(|p| {
            let id = p.id.clone();
            common::list_row(
                &p.id,
                p.name.clone(),
                p.description.is_empty().then(|| String::new()).or(Some(p.description.clone())),
                Some(common::bot_avatar(s, &p.id, 20.0, dark)),
                move |s: &mut App| s.route = crate::state::Route::Profile(id.clone(), crate::state::ProfileTab::Overview),
            )
        })
        .collect();
    let renaming = s.team_rename_id.as_deref() == Some(team_id);
    let saved = name.clone();
    let team_id_owned = team_id.to_string();
    let rename = rune::row()
        .key("team-rename")
        .gap(space::S2)
        .center_y()
        .child(
            rune_kit::TextInput::new(&s.team_rename)
                .placeholder("Rename the team")
                .on_edit(|s: &mut App| &mut s.team_rename)
                .build(&k),
        )
        .children(renaming.then(|| {
            let id = team_id.to_string();
            rune_kit::Button::new("Save name")
                .variant(rune_kit::ButtonVariant::Outline)
                .on_press(move |s: &mut App| {
                    let id = id.clone();
                    let name_text = s.team_rename.text.trim().to_string();
                    if name_text.is_empty() {
                        return;
                    }
                    s.net.mutate(
                        crate::net::endpoints::Mutation::PatchTeam { id: id.clone(), name: name_text },
                        &format!("patch-team:{id}"),
                    );
                })
                .build(&k)
        }))
        .child(
            rune_kit::Button::new(if renaming { "Cancel" } else { "Rename" })
                .variant(rune_kit::ButtonVariant::Ghost)
                .on_press(move |s: &mut App| {
                    if s.team_rename_id.as_deref() == Some(team_id_owned.as_str()) {
                        s.team_rename_id = None;
                    } else {
                        s.team_rename_id = Some(team_id_owned.clone());
                        s.team_rename = rune::TextEdit::new(saved.clone());
                    }
                })
                .build(&k),
        );
    let page = col()
        .key("team-page")
        .w_full()
        .padding(space::S6)
        .gap(16.0)
        .child(common::page_header(&name, dark, vec![]))
        .child(rename)
        .child(common::section_label("Bots", dark))
        .child(if members.is_empty() {
            common::empty_state("No bots call this team home.", dark)
        } else {
            common::list_card(dark).children(members)
        })
        .child(common::section_label("Shared folder", dark))
        .child(text("Team templates and the shared vault live here once the org carries them.".to_string()).font(ty::UI).color(t.muted_fg));
    el()
        .key("team")
        .w_full()
        .h_full()
        .fill(t.background)
        .child(
            el()
                .key("team-scroll")
                .w_full()
                .h_full()
                .min_h(0.0)
                .scroll(rune::ScrollSpec { stick_bottom: false })
                .child(page),
        )
}
