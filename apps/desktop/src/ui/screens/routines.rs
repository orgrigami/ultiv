//! `/routines`: schedules, webhooks and sensors with enable/trial/remove.

use crate::net::endpoints::Mutation;
use crate::state::App;
use crate::ui::common::{self, ty};
use rune::tok::space;
use rune::{col, el, text, El};
use rune_kit::{Button, ButtonVariant};

pub fn view(s: &App, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let page = col()
        .key("routines-page")
        .w_full()
        .padding(space::S6)
        .gap(space::S6)
        .child(common::page_header("Routines", dark, vec![]))
        .child(section("Schedules", s.has("cron"), cron_rows(s, dark), dark))
        .child(section("Webhooks", s.has("webhooks"), webhook_rows(s, dark), dark))
        .child(section("Sensors", s.has("sensors"), sensor_rows(s, dark), dark));
    el()
        .key("routines")
        .w_full()
        .h_full()
        .fill(t.background)
        .child(
            el()
                .key("routines-scroll")
                .w_full()
                .h_full()
                .min_h(0.0)
                .scroll(rune::ScrollSpec { stick_bottom: false })
                .child(page),
        )
}

/// The bot profile's Routines tab: the same content, scoped to one bot.
pub fn bot_routines(s: &App, bot_id: &str, dark: bool) -> El {
    let mut rows: Vec<El> = cron_rows_scoped(s, bot_id, dark);
    if rows.is_empty() {
        rows.push(common::empty_state("No schedules on this bot.", dark));
    }
    col().key("bot-routines").gap(space::S3).child(common::list_card(dark).children(rows))
}

fn section(title: &str, loaded: bool, rows: Vec<El>, dark: bool) -> El {
    let card = if !loaded {
        common::list_card(dark).child(common::skeleton(280.0, 40.0, dark))
    } else if rows.is_empty() {
        common::list_card(dark).child(common::empty_state("None.", dark))
    } else {
        common::list_card(dark).children(rows)
    };
    col().key(format!("sec:{title}")).gap(space::S2).child(common::section_label(title, dark)).child(card)
}

fn cron_rows(s: &App, dark: bool) -> Vec<El> {
    s.cron.iter().map(|r| cron_row(r, None, dark)).collect()
}

fn cron_rows_scoped(s: &App, bot_id: &str, dark: bool) -> Vec<El> {
    s.cron
        .iter()
        .filter(|r| r.get("profileId").and_then(serde_json::Value::as_str) == Some(bot_id))
        .map(|r| cron_row(r, None, dark))
        .collect()
}

fn cron_row(r: &crate::net::types::Row, scope: Option<&str>, dark: bool) -> El {
    let k = crate::theme::kit(dark);
    let t = crate::theme::tokens(dark);
    let id = crate::net::types::row_str(r, "id");
    let name = crate::net::types::row_str(r, "name");
    let schedule = crate::net::types::row_str(r, "schedule");
    let enabled = crate::net::types::row_bool(r, "enabled").unwrap_or(false);
    let key = format!("cron:{id}");
    let trial_id = id.clone();
    let toggle_id = id.clone();
    let mut row = el()
        .key(key)
        .w_full()
        .min_h(56.0)
        .px(space::S3)
        .py(space::S2)
        .gap(space::S3)
        .center_y()
        .child(
            col()
                .gap(2.0)
                .grow(1.0)
                .min_w(0.0)
                .child(text(if name.is_empty() { "(unnamed)" .into() } else { name }).font(ty::UI_MED).color(t.fg).max_lines(1))
                .child(text(schedule).font(ty::MONO).color(t.muted_fg).max_lines(1)),
        )
        .child(
            Button::new(if enabled { "Enabled" } else { "Disabled" })
                .variant(if enabled { ButtonVariant::Ghost } else { ButtonVariant::GhostMuted })
                .on_press(move |s: &mut App| {
                    let id = toggle_id.clone();
                    s.net.mutate(
                        Mutation::PatchCron { id: id.clone(), enabled: !enabled },
                        &format!("cron:{id}"),
                    );
                })
                .build(&k),
        )
        .child(
            Button::new("Try").variant(ButtonVariant::Outline).on_press(move |s: &mut App| {
                let id = trial_id.clone();
                s.net.mutate(Mutation::TryCron(id.clone()), &format!("cron-try:{id}"));
            })
            .build(&k),
        );
    if let Some(_scope) = scope {
        row = row.child(text("").font(ty::META));
    }
    row
}

fn webhook_rows(s: &App, dark: bool) -> Vec<El> {
    s.webhooks
        .iter()
        .map(|r| {
            let k = crate::theme::kit(dark);
            let t = crate::theme::tokens(dark);
            let name = crate::net::types::row_str(r, "name");
            let id = crate::net::types::row_str(r, "id");
            let test_id = id.clone();
            el()
                .key(format!("hook:{id}"))
                .w_full()
                .min_h(56.0)
                .px(space::S3)
                .py(space::S2)
                .gap(space::S3)
                .center_y()
                .child(text(if name.is_empty() { "(unnamed)".into() } else { name }).font(ty::UI_MED).color(t.fg).max_lines(1).grow(1.0))
                .child(
                    Button::new("Send test").variant(ButtonVariant::Outline).on_press(move |s: &mut App| {
                        let id = test_id.clone();
                        s.net.mutate(Mutation::TestWebhook(id.clone()), &format!("hook-test:{id}"));
                    })
                    .build(&k),
                )
        })
        .collect()
}

fn sensor_rows(s: &App, dark: bool) -> Vec<El> {
    s.sensors
        .iter()
        .map(|r| {
            let t = crate::theme::tokens(dark);
            let name = crate::net::types::row_str(r, "name");
            let words = crate::net::types::row_str(r, "prompt");
            el()
                .key(format!("sensor:{}", crate::net::types::row_str(r, "id")))
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
                        .child(text(if name.is_empty() { "(unnamed)".into() } else { name }).font(ty::UI_MED).color(t.fg).max_lines(1))
                        .children((!words.is_empty()).then(|| text(words).font(ty::META).color(t.muted_fg).max_lines(2))),
                )
        })
        .collect()
}
