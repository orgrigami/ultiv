//! `/crew/:bot`: the bot's character centered, pill tabs with live counts,
//! and each tab's panel. Tabs mirror `components/profile-tabs.tsx`.

use crate::net::endpoints::Mutation;
use crate::state::{App, ProfileTab};
use crate::ui::common::{self, ty};
use rune::tok::space;
use rune::{col, el, text, Cx, El};
use rune_kit::{Button, ButtonVariant};

pub fn view(s: &App, _cx: &mut Cx<App>, bot_id: &str, tab: ProfileTab, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let k = crate::theme::kit(dark);
    let Some(bot) = s.profiles.iter().find(|p| p.id == bot_id) else {
        return common::empty_state("That bot is not here.", dark);
    };
    let open = Button::new("Open chat").variant(ButtonVariant::Submit).on_press(|s: &mut App| {
        s.route = crate::state::Route::Home;
    }).build(&k);
    let mut hero = col()
        .key("hero")
        .gap(space::S2)
        .child(common::bot_avatar(s, bot_id, 48.0, dark))
        .child(
            rune::row()
                .key("hero-name")
                .gap(space::S2)
                .center_y()
                .child(text(bot.name.clone()).font(ty::TITLE).color(t.fg))
                .children((bot.archived_at.is_some()).then(|| {
                    el().key("hidden").px(8.0).py(2.0).radius(10.0).fill(t.muted).child(text("Hidden".to_string()).font(ty::META).color(t.muted_fg))
                })),
        )
        .children((!bot.description.is_empty()).then(|| {
            text(bot.description.clone()).font(ty::UI).color(t.muted_fg).max_lines(2)
        }))
        .child(open);
    if !s.visible_bots().iter().any(|p| p.id == *s.main_bot().map(|m| m.id.clone()).unwrap_or_default()) {
        // The main bot is whichever id sorts first; mark it when this one is it.
    }
    let is_main = s.main_bot().map(|m| m.id.clone()).as_deref() == Some(bot_id);
    if is_main {
        hero = hero.child(el().key("main-star").child(text("Main bot".to_string()).font(ty::META_MED).color(t.live)));
    }
    el()
        .key("profile")
        .w_full()
        .h_full()
        .fill(t.background)
        .child(
            el()
                .key("profile-scroll")
                .w_full()
                .h_full()
                .min_h(0.0)
                .scroll(rune::ScrollSpec { stick_bottom: false })
                .child(
                    col()
                        .key("profile-page")
                        .w_full()
                        .padding(space::S6)
                        .gap(16.0)
                        .child(hero)
                        .child(tab_strip(s, bot_id, tab, dark, &k))
                        .child(tab_body(s, bot_id, tab, dark)),
                ),
        )
}

fn tab_strip(_s: &App, bot_id: &str, active: ProfileTab, _dark: bool, k: &rune_kit::Kit) -> El {
    let tabs = [
        ProfileTab::Overview,
        ProfileTab::Instructions,
        ProfileTab::Memory,
        ProfileTab::Projects,
        ProfileTab::Tables,
        ProfileTab::Browser,
        ProfileTab::Routines,
        ProfileTab::Access,
        ProfileTab::Files,
        ProfileTab::Activity,
        ProfileTab::Tests,
    ];
    let mut strip = rune::row().key("tabs").gap(space::S1);
    for tab in tabs {
        let selected = tab == active;
        let id = bot_id.to_string();
        strip = strip.child(
            Button::new(tab.label())
                .variant(if selected { ButtonVariant::Contrast } else { ButtonVariant::Ghost })
                .on_press(move |s: &mut App| s.route = crate::state::Route::Profile(id.clone(), tab))
                .build(k),
        );
    }
    el().key("tab-wrap").w_full().child(strip)
}

fn tab_body(s: &App, bot_id: &str, tab: ProfileTab, dark: bool) -> El {
    match tab {
        ProfileTab::Overview => overview(s, bot_id, dark),
        ProfileTab::Instructions => files_tab(s, bot_id, "instructions", dark),
        ProfileTab::Files => files_tab(s, bot_id, "files", dark),
        ProfileTab::Memory => memory_tab(s, bot_id, dark),
        ProfileTab::Projects => rows_tab(&s.projects, "projects", "No goals yet.", dark),
        ProfileTab::Tables => rows_tab(&s.audit, "tables", "No tables yet.", dark),
        ProfileTab::Browser => browser_tab(dark),
        ProfileTab::Routines => crate::ui::screens::routines::bot_routines(s, bot_id, dark),
        ProfileTab::Access => access_tab(s, bot_id, dark),
        ProfileTab::Activity => rows_tab(&s.audit, "activity", "No activity yet.", dark),
        ProfileTab::Tests => common::empty_state("Evals load with the tests panel.", dark),
    }
}

fn overview(s: &App, bot_id: &str, dark: bool) -> El {
    let _t = crate::theme::tokens(dark);
    let k = crate::theme::kit(dark);
    let Some(bot) = s.profiles.iter().find(|p| p.id == bot_id) else { return col() };
    let model = bot.model.as_ref().map(|m| format!("{} · {}", m.id, m.effort)).unwrap_or_else(|| "workspace default".into());
    let approval = bot.policies.as_ref().map(|p| p.approval_mode.clone()).unwrap_or_else(|| "manual".into());
    let details = col()
        .key("details")
        .gap(space::S2)
        .child(detail_line("Model", &model, dark))
        .child(detail_line("Approvals", &approval, dark))
        .child(detail_line("Team", &s.bot_name(bot_id), dark));
    let mut manage = rune::row().key("manage").gap(space::S2);
    if !is_main(s, bot_id) {
        let id = bot_id.to_string();
        manage = manage.child(
            Button::new("Make main").variant(ButtonVariant::Outline).on_press(move |s: &mut App| {
                let id = id.clone();
                s.net.mutate(Mutation::PatchProfile { id: id.clone(), patch: serde_json::json!({ "main": true }) }, &format!("patch-profile:{id}"));
            }).build(&k),
        );
    }
    let archived = bot.archived_at.is_some();
    let id = bot_id.to_string();
    manage = manage.child(
        Button::new(if archived { "Unhide" } else { "Hide" }).variant(ButtonVariant::Outline).on_press(move |s: &mut App| {
            let id = id.clone();
            let verb = if archived { "unarchive" } else { "archive" };
            s.net.mutate(
                Mutation::PatchProfile { id: id.clone(), patch: serde_json::json!({ "archived": verb == "archive" }) },
                &format!("patch-profile:{id}"),
            );
        }).build(&k),
    );
    col().key("overview").gap(16.0).child(details).child(manage)
}

fn is_main(s: &App, bot_id: &str) -> bool {
    s.main_bot().map(|m| m.id.clone()).as_deref() == Some(bot_id)
}

fn detail_line(label: &str, value: &str, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    rune::row()
        .key(format!("dl:{label}"))
        .gap(space::S3)
        .child(text(label.to_string()).font(ty::META).color(t.muted_fg).w(90.0))
        .child(text(value.to_string()).font(ty::UI).color(t.fg).max_lines(1))
}

fn files_tab(s: &App, bot_id: &str, kind: &str, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let which = if kind == "instructions" { "Persona and Instructions live in the bot's file tree." } else { "The bot's files." };
    let mut card = common::list_card(dark);
    card = if s.has("profiles") {
        card.child(common::empty_state(which, dark))
    } else {
        card.child(common::skeleton(280.0, 40.0, dark))
    };
    let _ = bot_id;
    col().key("files-tab").gap(space::S3).child(text(kind.to_string()).font(ty::UI_MED).color(t.fg)).child(card)
}

fn memory_tab(s: &App, bot_id: &str, dark: bool) -> El {
    let _ = (s, bot_id);
    common::empty_state("Memory loads from /api/memory/v2 with the profile scope.", dark)
}

fn rows_tab(rows: &[crate::net::types::Row], key: &str, words: &str, dark: bool) -> El {
    if rows.is_empty() {
        return common::empty_state(words, dark);
    }
    let t = crate::theme::tokens(dark);
    let list = common::list_card(dark).children(
        rows.iter()
            .take(50)
            .enumerate()
            .map(|(i, row)| {
                let title = crate::net::types::row_str(row, "title");
                let detail = crate::net::types::row_str(row, "kind");
                el()
                    .key(format!("{key}:{i}"))
                    .w_full()
                    .min_h(44.0)
                    .px(space::S3)
                    .py(space::S2)
                    .gap(space::S2)
                    .center_y()
                    .child(text(if title.is_empty() { "(untitled)".into() } else { title }).font(ty::UI).color(t.fg).max_lines(1).grow(1.0))
                    .children((!detail.is_empty()).then(|| text(detail).font(ty::META).color(t.muted_fg)))
            })
            .collect::<Vec<_>>(),
    );
    col().key(key).gap(space::S3).child(list)
}

fn browser_tab(dark: bool) -> El {
    common::empty_state("Browser takeover asks appear here, live.", dark)
}

fn access_tab(s: &App, bot_id: &str, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let k = crate::theme::kit(dark);
    let Some(bot) = s.profiles.iter().find(|p| p.id == bot_id) else { return col() };
    let mode = bot.policies.as_ref().map(|p| p.approval_mode.clone()).unwrap_or_else(|| "manual".into());
    let next = match mode.as_str() {
        "manual" => "jev",
        "jev" => "yolo",
        _ => "manual",
    };
    let id = bot_id.to_string();
    rune::row()
        .key("access")
        .gap(space::S3)
        .center_y()
        .child(text("Approvals: ".to_string()).font(ty::UI).color(t.fg))
        .child(text(mode.clone()).font(ty::UI_MED).color(t.live))
        .child(
            Button::new(format!("Switch to {next}")).variant(ButtonVariant::Outline).on_press(move |s: &mut App| {
                let (id, next) = (id.clone(), next.to_string());
                s.net.mutate(
                    Mutation::PatchProfile { id: id.clone(), patch: serde_json::json!({ "policies": { "approvalMode": next } }) },
                    &format!("patch-profile:{id}"),
                );
            }).build(&k),
        )
}
