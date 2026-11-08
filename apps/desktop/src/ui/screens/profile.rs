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
        ProfileTab::Browser => browser_tab(s, dark),
        ProfileTab::Routines => crate::ui::screens::routines::bot_routines(s, bot_id, dark),
        ProfileTab::Access => access_tab(s, bot_id, dark),
        ProfileTab::Activity => rows_tab(&s.audit, "activity", "No activity yet.", dark),
        ProfileTab::Tests => tests_tab(s, bot_id, dark),
    }
}

/// The Tests tab: the bot's saved eval cases with their reference replies,
/// a Run-all button, and the run history with per-check words.
fn tests_tab(s: &App, bot_id: &str, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let k = crate::theme::kit(dark);
    let Some(cases) = s.evals.get(bot_id) else {
        return common::empty_state("Loading the saved cases…", dark);
    };
    let run_all = rune_kit::Button::new("Run all cases")
        .variant(rune_kit::ButtonVariant::Submit)
        .disabled(cases.is_empty())
        .on_press({
            let bot = bot_id.to_string();
            let ids = cases.iter().filter_map(|c| crate::net::types::row_str(c, "id").into()).collect::<Vec<String>>();
            move |s: &mut App| {
                let (bot, ids) = (bot.clone(), ids.clone());
                s.net.mutate(crate::net::endpoints::Mutation::EvalRun { bot: bot.clone(), case_ids: ids }, &format!("eval-run:{bot}"));
            }
        })
        .build(&k);
    let mut parts: Vec<El> = Vec::new();
    if cases.is_empty() {
        parts.push(common::empty_state("No saved cases yet. Capture one from a chat on the web client.", dark));
    } else {
        let rows: Vec<El> = cases
            .iter()
            .map(|c| {
                let title = crate::net::types::row_str(c, "title");
                let input = crate::net::types::row_str(c, "input");
                let reply = c.get("reference").and_then(|r| r.get("reply")).and_then(serde_json::Value::as_str).unwrap_or("");
                let expects = c.get("expect").and_then(serde_json::Value::as_array).map(Vec::len).unwrap_or(0);
                el()
                    .key(format!("eval:{}", crate::net::types::row_str(c, "id")))
                    .w_full()
                    .px(space::S3)
                    .py(space::S2)
                    .gap(space::S1)
                    .child(text(if title.is_empty() { "A saved case".into() } else { title }).font(ty::UI_MED).color(t.fg).max_lines(1))
                    .child(text(input).font(ty::UI).color(t.muted_fg).max_lines(2))
                    .children((!reply.is_empty()).then(|| {
                        text(format!("Reference: {reply}")).font(ty::META).color(t.muted_fg).max_lines(2)
                    }))
                    .children((expects > 0).then(|| {
                        text(format!("{expects} check{}", if expects == 1 { "" } else { "s" })).font(ty::META).color(t.live)
                    }))
            })
            .collect();
        parts.push(common::list_card(dark).children(rows));
    }
    parts.push(run_all);
    parts.push(run_history(s, dark));
    col().key("tests-tab").gap(space::S3).children(parts)
}

/// The run history: status, the model, and each case's checks with words.
fn run_history(s: &App, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    if !s.has("eval-runs") {
        return common::empty_state("Loading the runs…", dark);
    }
    if s.eval_runs.is_empty() {
        return common::empty_state("No runs yet.", dark);
    }
    let rows: Vec<El> = s
        .eval_runs
        .iter()
        .map(|run| {
            let status = crate::net::types::row_str(run, "status");
            let model = crate::net::types::row_str(run, "model");
            let color = match status.as_str() {
                "running" => t.live,
                "failed" => t.deny,
                "done" => t.success,
                _ => t.muted_fg,
            };
            let mut results: Vec<El> = Vec::new();
            if let Some(list) = run.get("results").and_then(serde_json::Value::as_array) {
                for (i, r) in list.iter().enumerate() {
                    let ok = r.get("ok").and_then(serde_json::Value::as_bool).unwrap_or(false);
                    let case_id = crate::net::types::row_str(r, "caseId");
                    let case_title = s
                        .evals
                        .values()
                        .flat_map(|cases| cases.iter())
                        .find(|c| crate::net::types::row_str(c, "id") == case_id)
                        .map(|c| crate::net::types::row_str(c, "title"))
                        .unwrap_or_else(|| case_id.clone());
                    let failed_checks: Vec<String> = r["checks"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default()
                        .iter()
                        .filter(|c| c.get("ok").and_then(serde_json::Value::as_bool) != Some(true))
                        .filter_map(|c| c.get("name").and_then(serde_json::Value::as_str).map(String::from))
                        .collect();
                    results.push(
                        rune::row()
                            .key(format!("res:{i}"))
                            .gap(space::S2)
                            .center_y()
                            .child(el().key("dot").size(7.0, 7.0).radius(3.5).fill(if ok { t.success } else { t.deny }))
                            .child(text(case_title).font(ty::UI).color(t.fg).max_lines(1).grow(1.0))
                            .children((!failed_checks.is_empty()).then(|| {
                                text(format!("failed: {}", failed_checks.join(", "))).font(ty::META).color(t.deny).max_lines(1)
                            })),
                    );
                }
            }
            col()
                .key(format!("run:{}", crate::net::types::row_str(run, "id")))
                .gap(space::S2)
                .child(
                    rune::row()
                        .key("run-head")
                        .gap(space::S2)
                        .center_y()
                        .child(text(status.clone()).font(ty::META_MED).color(color))
                        .children((!model.is_empty()).then(|| text(model).font(ty::MONO).color(t.muted_fg).max_lines(1))),
                )
                .children(results)
        })
        .collect();
    col()
        .key("run-history")
        .gap(space::S2)
        .child(common::section_label("Runs", dark))
        .child(common::list_card(dark).children(rows))
}

/// The memory v2 panel: what the bot remembers — core lines, facts, and the
/// open proposal count, with the tidy words. Read-only here; the lifecycle
/// buttons live on the web client for now.
fn memory_tab(s: &App, bot_id: &str, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let Some(memory) = s.memories.get(bot_id) else {
        return common::empty_state("Memory loads with the tab…", dark);
    };
    let mut rows: Vec<El> = Vec::new();
    if let Some(core) = memory.get("core") {
        for (i, side) in ["owner", "profile"].into_iter().enumerate() {
            if let Some(lines) = core.get(side).and_then(serde_json::Value::as_array) {
                for (j, line) in lines.iter().enumerate() {
                    let words = crate::net::types::row_str(line, "text");
                    if words.is_empty() {
                        continue;
                    }
                    rows.push(
                        el()
                            .key(format!("core:{i}:{j}"))
                            .w_full()
                            .px(space::S3)
                            .py(space::S2)
                            .gap(space::S2)
                            .center_y()
                            .child(text("core".to_string()).font(ty::META_MED).color(t.live).w(52.0))
                            .child(text(words).font(ty::UI).color(t.fg).max_lines(2).grow(1.0)),
                    );
                }
            }
        }
    }
    if let Some(facts) = memory.get("facts").and_then(serde_json::Value::as_array) {
        for (j, fact) in facts.iter().take(50).enumerate() {
            let words = crate::net::types::row_str(fact, "text");
            if words.is_empty() {
                continue;
            }
            rows.push(
                el()
                    .key(format!("fact:{j}"))
                    .w_full()
                    .px(space::S3)
                    .py(space::S2)
                    .gap(space::S2)
                    .center_y()
                    .child(text(words).font(ty::UI).color(t.fg).max_lines(3).grow(1.0)),
            );
        }
    }
    let open = memory.get("proposals").and_then(serde_json::Value::as_array).map(Vec::len).unwrap_or(0);
    let proposals = (open > 0).then(|| {
        text(format!("{open} proposal{} waiting for a verdict", if open == 1 { "" } else { "s" }))
            .font(ty::META)
            .color(t.live)
    });
    let body = if rows.is_empty() {
        common::empty_state("This bot remembers nothing yet.", dark)
    } else {
        common::list_card(dark).children(rows)
    };
    col().key("memory-tab").gap(space::S3).children(proposals).child(body)
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

/// The bot's files: the two owner-editable files (Persona, Instructions)
/// render as editors with Save; versions stay on the web client for now.
fn files_tab(s: &App, bot_id: &str, kind: &str, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let k = crate::theme::kit(dark);
    let which: &str = if kind == "instructions" { "Instructions" } else { "Persona" };
    let key = format!("{bot_id}:{kind}");
    let loaded_key = format!("bot-file:{key}");
    if !s.has(&loaded_key) {
        return col()
            .key("files-tab")
            .gap(space::S3)
            .child(text(which.to_string()).font(ty::UI_MED).color(t.fg))
            .child(common::skeleton(320.0, 80.0, dark));
    }
    let saved = s.bot_files_saved.get(&key).cloned().unwrap_or_default();
    let draft = s.bot_files.get(&key);
    let dirty = draft.map(|d| d.text != saved).unwrap_or(false);
    let editor = match draft {
        Some(edit) => {
            let edit_key = key.clone();
            rune_kit::TextArea::new(edit)
                .placeholder(format!(
                    "Its {}.",
                    if kind == "instructions" { "instructions" } else { "persona" }
                ))
                .on_edit(move |s: &mut App| {
                    s.bot_files.get_mut(&edit_key).unwrap_or(&mut s.scratch_edit)
                })
                .build(&k)
        }
        None => rune_kit::TextArea::new(&s.scratch_edit).build(&k),
    };
    let save_key = key.clone();
    let save_kind = kind.to_string();
    let save_profile = bot_id.to_string();
    col()
        .key("files-tab")
        .gap(space::S3)
        .child(
            rune::row()
                .key("file-head")
                .gap(space::S2)
                .center_y()
                .child(text(which.to_string()).font(ty::UI_MED).color(t.fg))
                .children(dirty.then(|| text("Unsaved".to_string()).font(ty::META).color(t.live)))
                .child(el().key("space").grow(1.0))
                .child(
                    rune_kit::Button::new("Save")
                        .variant(rune_kit::ButtonVariant::Submit)
                        .disabled(!dirty)
                        .on_press(move |s: &mut App| save_file(s, &save_profile, &save_kind, &save_key))
                        .build(&k),
                ),
        )
        .child(editor)
}

fn save_file(s: &mut App, profile: &str, kind: &str, key: &str) {
    let Some(edit) = s.bot_files.get(key) else { return };
    let text = edit.text.clone();
    s.net.mutate(
        crate::net::endpoints::Mutation::SaveBotFile { profile: profile.to_string(), file: kind.to_string(), text },
        &format!("bot-file:{key}"),
    );
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

/// The Browser tab: the bot's open takeover asks (the live cast drives from
/// the web client; the ask list keeps the desktop honest about them).
fn browser_tab(s: &App, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    if !s.has("takeovers") {
        return common::empty_state("Checking for takeover asks…", dark);
    }
    if s.takeovers.is_empty() {
        return common::empty_state("No takeover asks right now.", dark);
    }
    let rows: Vec<El> = s
        .takeovers
        .iter()
        .map(|ask| {
            let why = crate::net::types::row_str(ask, "reason");
            let url = crate::net::types::row_str(ask, "url");
            el()
                .key(format!("take:{}", crate::net::types::row_str(ask, "id")))
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
                        .child(text(if why.is_empty() { "It wants the browser".into() } else { why }).font(ty::UI_MED).color(t.fg).max_lines(1))
                        .children((!url.is_empty()).then(|| text(url).font(ty::MONO).color(t.muted_fg).max_lines(1))),
                )
                .child(text("waiting".to_string()).font(ty::META).color(t.live))
                .children(std::iter::once({
                    let take_id = crate::net::types::row_str(ask, "id");
                    rune_kit::Button::new("Take it here")
                        .variant(rune_kit::ButtonVariant::Submit)
                        .on_press(move |s: &mut App| {
                            let take_id = take_id.clone();
                            crate::ui::open_dock(s, crate::state::DockTab::Takeover(take_id));
                        })
                        .build(&crate::theme::kit(dark))
                }))
        })
        .collect();
    common::list_card(dark).children(rows)
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
