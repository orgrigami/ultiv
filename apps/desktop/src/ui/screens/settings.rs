//! `/settings`: server check, workspace default model, task default, pause
//! the crew, nodes, appearance, and sign-in.

use crate::net::endpoints::Mutation;
use crate::state::App;
use crate::ui::common::{self, ty};
use rune::tok::space;
use rune::{col, el, text, El};
use rune_kit::{Button, ButtonVariant};

pub fn view(s: &App, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let k = crate::theme::kit(dark);
    let theme_btn = Button::new(format!("Theme: {}", s.theme.label())).variant(ButtonVariant::Outline).on_press(|s: &mut App| {
        s.theme = s.theme.next();
    }).build(&k);
    let sign_out = Button::new("Sign out").variant(ButtonVariant::Outline).on_press(|s: &mut App| {
        s.net.mutate(Mutation::SignOut, "sign-out");
    }).build(&k);
    let mut page = col()
        .key("settings-page")
        .w_full()
        .padding(space::S6)
        .gap(space::S6)
        .child(common::page_header("Settings", dark, vec![theme_btn, sign_out]))
        .child(server_check(s, dark))
        .child(model_setting(s, dark))
        .child(task_setting(s, dark))
        .child(pause_setting(s, dark))
        .child(nodes_section(s, dark))
        .child(appearance_words(dark));
    if let Some(check) = &s.check {
        page = page.child(
            col()
                .key("env")
                .gap(space::S1)
                .child(text(format!("meaning search: {}", on_off(check.meaning))).font(ty::MONO).color(t.muted_fg))
                .child(text(format!("microvm: {}", on_off(check.microvm))).font(ty::MONO).color(t.muted_fg))
                .children(check.node.clone().map(|n| {
                    text(format!("node: {n}")).font(ty::MONO).color(t.muted_fg)
                })),
        );
    }
    el()
        .key("settings")
        .w_full()
        .h_full()
        .fill(t.background)
        .child(
            el()
                .key("settings-scroll")
                .w_full()
                .h_full()
                .min_h(0.0)
                .scroll(rune::ScrollSpec { stick_bottom: false })
                .child(page),
        )
}

fn on_off(v: Option<bool>) -> &'static str {
    match v {
        Some(true) => "on",
        Some(false) => "off",
        None => "unknown",
    }
}

fn server_check(s: &App, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let word = if s.has("server-check") { "checked" } else { "checking…" };
    col()
        .key("sec-server")
        .gap(space::S2)
        .child(common::section_label("Server", dark))
        .child(
            el()
                .key("server-line")
                .padding(space::S3)
                .radius(10.0)
                .fill(t.card)
                .border(1.0, t.hairline)
                .child(text(format!("{} · {}", s.server, word)).font(ty::MONO).color(t.fg)),
        )
}

fn model_setting(s: &App, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let current = s
        .settings
        .model_ref
        .clone()
        .or_else(|| s.workspace_default.as_ref().map(|m| m.id.clone()))
        .unwrap_or_else(|| "the default model".into());
    let k = crate::theme::kit(dark);
    col()
        .key("sec-model")
        .gap(space::S2)
        .child(common::section_label("Workspace default model", dark))
        .child(
            rune::row()
                .key("model-row")
                .gap(space::S3)
                .center_y()
                .child(text(current).font(ty::UI).color(t.fg))
                .child(
                    Button::new("Cycle effort").variant(ButtonVariant::Outline).on_press(|s: &mut App| {
                        let ref_ = s.settings.model_ref.clone();
                        let effort = s.settings.effort.clone().unwrap_or_default();
                        let efforts = ["low", "medium", "high"];
                        let i = efforts.iter().position(|e| *e == effort).map(|i| (i + 1) % efforts.len()).unwrap_or(0);
                        s.net.mutate(
                            Mutation::SetModel { ref_, effort: Some(efforts[i].to_string()) },
                            "set-model",
                        );
                    }).build(&k),
                ),
        )
}

fn task_setting(s: &App, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let k = crate::theme::kit(dark);
    let max = s.settings.max_running_tasks.unwrap_or(2.0) as u32;
    col()
        .key("sec-tasks")
        .gap(space::S2)
        .child(common::section_label("Task default", dark))
        .child(
            rune::row()
                .key("task-row")
                .gap(space::S3)
                .center_y()
                .child(text(format!("{max} tasks may run at once")).font(ty::UI).color(t.fg))
                .child(
                    Button::new("+1").variant(ButtonVariant::Outline).on_press(move |s: &mut App| {
                        let n = (s.settings.max_running_tasks.unwrap_or(2.0) + 1.0).min(16.0);
                        s.net.mutate(Mutation::SetTasksMax(n), "set-tasks-max");
                    }).build(&k),
                )
                .child(
                    Button::new("-1").variant(ButtonVariant::Outline).on_press(move |s: &mut App| {
                        let n = (s.settings.max_running_tasks.unwrap_or(2.0) - 1.0).max(1.0);
                        s.net.mutate(Mutation::SetTasksMax(n), "set-tasks-max");
                    }).build(&k),
                ),
        )
}

fn pause_setting(s: &App, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let k = crate::theme::kit(dark);
    let paused = s.settings.paused == Some(true);
    col()
        .key("sec-pause")
        .gap(space::S2)
        .child(common::section_label("Pause the crew", dark))
        .child(
            rune::row()
                .key("pause-row")
                .gap(space::S3)
                .center_y()
                .child(
                    text(if paused { "Paused: tasks queue and schedules hold." } else { "The crew is working." }.to_string())
                        .font(ty::UI)
                        .color(t.fg),
                )
                .child(
                    Button::new(if paused { "Resume" } else { "Pause" })
                        .variant(ButtonVariant::Outline)
                        .on_press(move |s: &mut App| s.net.mutate(Mutation::Pause(!paused), "pause"))
                        .build(&k),
                ),
        )
}

/// Nodes: the paired machines, and the Pair button whose token shows once.
fn nodes_section(s: &App, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let k = crate::theme::kit(dark);
    let mut rows: Vec<El> = Vec::new();
    if let Some(nodes) = s.nodes.as_ref() {
        for node in nodes {
            let name = crate::net::types::row_str(node, "name");
            let connected = crate::net::types::row_bool(node, "connected").unwrap_or(false);
            rows.push(
                el()
                    .key(format!("node:{}", crate::net::types::row_str(node, "id")))
                    .w_full()
                    .min_h(44.0)
                    .px(space::S3)
                    .py(space::S2)
                    .gap(space::S2)
                    .center_y()
                    .child(el().key("dot").size(8.0, 8.0).radius(4.0).fill(if connected { t.success } else { t.muted_fg }))
                    .child(text(if name.is_empty() { "A node".into() } else { name }).font(ty::UI).color(t.fg).grow(1.0))
                    .child(text(if connected { "connected" } else { "offline" }.to_string()).font(ty::META).color(t.muted_fg)),
            );
        }
    }
    let mut section = col()
        .key("sec-nodes")
        .gap(space::S2)
        .child(common::section_label("Nodes", dark))
        .child(if rows.is_empty() {
            common::empty_state("No machines paired.", dark)
        } else {
            common::list_card(dark).children(rows)
        })
        .child(
            rune_kit::Button::new("Pair a machine")
                .variant(rune_kit::ButtonVariant::Outline)
                .on_press(|s: &mut App| {
                    s.net.mutate(crate::net::endpoints::Mutation::PairNode("A desktop pair".into()), "pair-node");
                })
                .build(&k),
        );
    if let Some(token) = &s.node_token {
        section = section.child(
            el()
                .key("node-token")
                .w_full()
                .padding(space::S3)
                .radius(10.0)
                .fill(t.live.alpha(0.12))
                .child(
                    col()
                        .gap(2.0)
                        .child(text("This token is shown once:".to_string()).font(ty::META_MED).color(t.fg))
                        .child(text(token.clone()).font(ty::MONO).color(t.fg)),
                ),
        );
    }
    section
}

fn appearance_words(dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    col()
        .key("sec-approvals")
        .gap(space::S2)
        .child(common::section_label("Approvals", dark))
        .child(
            text(
                "manual asks you each time; jev lets the gate decide; yolo lets everything through. Per-bot switches live on each bot's Access tab."
                    .to_string(),
            )
            .font(ty::UI)
            .color(t.muted_fg),
        )
}
