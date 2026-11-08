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
        .child(templates_section(s, team_id, dark))
        .child(common::section_label("Vault grants", dark))
        .child(grants_section(s, dark));
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

/// The team's published templates: Copy here for the target team, Unpublish
/// to take it down.
fn templates_section(s: &App, team_id: &str, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let k = crate::theme::kit(dark);
    let Some(templates) = s.templates.get(team_id) else {
        return common::empty_state("Loading the team's templates…", dark);
    };
    if templates.is_empty() {
        return common::empty_state("Nothing published as a template yet.", dark);
    }
    let rows: Vec<El> = templates
        .iter()
        .map(|tm| {
            let name = crate::net::types::row_str(tm, "name");
            let kind = crate::net::types::row_str(tm, "kind");
            let id = crate::net::types::row_str(tm, "id");
            let copy_pair = (id.clone(), team_id.to_string());
            let unpublish_id = id.clone();
            el()
                .key(format!("template:{id}"))
                .w_full()
                .min_h(56.0)
                .px(space::S3)
                .py(space::S2)
                .gap(space::S2)
                .center_y()
                .child(
                    col()
                        .gap(2.0)
                        .grow(1.0)
                        .min_w(0.0)
                        .child(text(if name.is_empty() { "A template".to_string() } else { name }).font(ty::UI_MED).color(t.fg).max_lines(1))
                        .children((!kind.is_empty()).then(|| text(kind).font(ty::META).color(t.muted_fg))),
                )
                .children(std::iter::once(
                    rune_kit::Button::new("Copy here")
                        .variant(rune_kit::ButtonVariant::Outline)
                        .on_press(move |s: &mut App| {
                            let (id, team) = copy_pair.clone();
                            let tag = format!("template:{team}");
                            s.net.mutate(crate::net::endpoints::Mutation::TemplateCopy { id, team }, &tag);
                        })
                        .build(&k),
                ))
                .children(std::iter::once(
                    rune_kit::Button::new("Unpublish")
                        .variant(rune_kit::ButtonVariant::Ghost)
                        .on_press(move |s: &mut App| {
                            let id = unpublish_id.clone();
                            s.net.mutate(crate::net::endpoints::Mutation::TemplateUnpublish(id.clone()), &format!("template:{id}"));
                        })
                        .build(&k),
                ))
        })
        .collect();
    common::list_card(dark).children(rows)
}

/// The org's active grants, with revoke.
fn grants_section(s: &App, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let k = crate::theme::kit(dark);
    let Some(grants) = &s.grants else {
        return common::empty_state("Loading the grants…", dark);
    };
    if grants.is_empty() {
        return common::empty_state("No vault or connector grants are live.", dark);
    }
    let rows: Vec<El> = grants
        .iter()
        .map(|grant| {
            let id = crate::net::types::row_str(grant, "id");
            let kind = grant.get("resource").map(|r| crate::net::types::row_str(r, "kind")).unwrap_or_default();
            let home = grant.get("resource").map(|r| crate::net::types::row_str(r, "home")).unwrap_or_default();
            let grantee = grant.get("grantee").map(|g| crate::net::types::row_str(g, "team")).unwrap_or_default();
            let words = if grantee.is_empty() { kind.clone() } else { format!("{kind} → {grantee}") };
            let revoke_id = id.clone();
            el()
                .key(format!("grant:{id}"))
                .w_full()
                .min_h(56.0)
                .px(space::S3)
                .py(space::S2)
                .gap(space::S2)
                .center_y()
                .child(
                    col()
                        .gap(2.0)
                        .grow(1.0)
                        .min_w(0.0)
                        .child(text(if words.is_empty() { "A grant".to_string() } else { words }).font(ty::UI).color(t.fg).max_lines(1))
                        .children((!home.is_empty()).then(|| text(home).font(ty::META).color(t.muted_fg).max_lines(1))),
                )
                .children(std::iter::once(
                    rune_kit::Button::new("Revoke")
                        .variant(rune_kit::ButtonVariant::Outline)
                        .on_press(move |s: &mut App| {
                            let id = revoke_id.clone();
                            s.net.mutate(crate::net::endpoints::Mutation::RevokeGrant(id.clone()), &format!("grant:{id}"));
                        })
                        .build(&k),
                ))
        })
        .collect();
    common::list_card(dark).children(rows)
}
