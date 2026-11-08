//! `/now`, the check-in: Needs you first, then running tasks and clean
//! finishes, goals in motion, and the newest files. `Page wide`.

use crate::net::endpoints::{Fetch, Mutation};
use crate::state::App;
use crate::ui::common::{self, ty};
use rune::tok::space;
use rune::{col, el, text, El};
use rune_kit::{Button, ButtonVariant};

pub fn view(s: &App, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let resumed = s.settings.paused != Some(true);
    let pause = Button::new(if resumed { "Pause the crew" } else { "Resume the crew" })
        .variant(ButtonVariant::Outline)
        .on_press(move |s: &mut App| s.net.mutate(Mutation::Pause(resumed), "pause"))
        .build(&crate::theme::kit(dark));
    let body = col()
        .key("now-body")
        .w_full()
        .padding(space::S6)
        .gap(space::S6)
        .children(paused_banner(s, dark))
        .child(needs_you(s, dark))
        .child(tasks_sections(s, dark))
        .child(goals(s, dark))
        .child(files(s, dark));
    el()
        .key("now")
        .w_full()
        .h_full()
        .fill(t.background)
        .child(
            el()
                .key("now-scroll")
                .w_full()
                .h_full()
                .min_h(0.0)
                .scroll(rune::ScrollSpec { stick_bottom: false })
                .child(
                    el()
                        .key("now-page")
                        .w_full()
                        .padding(space::S6)
                        .child(common::page_header("Now", dark, vec![pause]))
                        .child(body),
                ),
        )
}

fn paused_banner(s: &App, dark: bool) -> Option<El> {
    if s.settings.paused != Some(true) {
        return None;
    }
    let t = crate::theme::tokens(dark);
    Some(
        el()
            .key("paused")
            .w_full()
            .padding(space::S3)
            .radius(10.0)
            .fill(t.warning.alpha(0.12))
            .child(
                text("The crew is paused: tasks queue and schedules, webhooks and sensors hold.".to_string())
                    .font(ty::UI)
                    .color(t.warning),
            ),
    )
}

fn needs_you(s: &App, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let k = crate::theme::kit(dark);
    let mut card = common::list_card(dark).key("needs");
    if !s.has("approvals") {
        card = card.child(common::skeleton(300.0, 56.0, dark));
        return section("Needs you", vec![card], dark);
    }
    let mut rows: Vec<El> = Vec::new();
    for a in &s.approvals {
        let who = s.bot_name(&a.profile);
        let (key, decide) = (a.call_id.clone(), (a.conversation_id.clone(), a.call_id.clone()));
        rows.push(
            el()
                .key(format!("need:{key}"))
                .w_full()
                .min_h(56.0)
                .px(space::S3)
                .py(space::S2)
                .gap(space::S2)
                .center_y()
                .radius(10.0)
                .fill(t.card)
                .border(1.0, t.signal.alpha(0.4))
                .child(
                    col()
                        .key("need-lines")
                        .gap(2.0)
                        .grow(1.0)
                        .min_w(0.0)
                        .child(
                            text(format!("{who} wants to {}", tool_words(&a.name)))
                                .font(ty::UI_MED)
                                .color(t.fg)
                                .max_lines(2),
                        )
                        .children(a.reason.clone().map(|r| text(r).font(ty::META).color(t.muted_fg).max_lines(2))),
                )
                .child(row_of_buttons(dark, &k, decide)),
        );
    }
    for task in s.tasks.iter().filter(|t| t.status == "failed") {
        let title = task.title.clone().unwrap_or_else(|| task.prompt.clone());
        let id = task.id.clone();
        rows.push(
            el()
                .key(format!("failed:{}", task.id))
                .w_full()
                .min_h(56.0)
                .px(space::S3)
                .py(space::S2)
                .gap(space::S3)
                .center_y()
                .radius(10.0)
                .fill(t.card)
                .border(1.0, t.hairline)
                .child(col().gap(2.0).grow(1.0).min_w(0.0)
                    .child(text(title).font(ty::UI_MED).color(t.fg).max_lines(1))
                    .child(text("Failed".to_string()).font(ty::META).color(t.deny)))
                .child(
                    Button::new("Retry the chat").variant(ButtonVariant::Outline).on_press(move |s: &mut App| {
                        s.net.fetch(Fetch::TaskActivity(id.clone()));
                    }).build(&k),
                ),
        );
    }
    if let Some(needs) = &s.needs {
        for parked in needs.parked.as_deref().unwrap_or(&[]) {
            let id = parked.get("taskId").and_then(serde_json::Value::as_str).unwrap_or("").to_string();
            if id.is_empty() {
                continue;
            }
            rows.push(parked_row(parked, &id, dark, &k));
        }
    }
    if rows.is_empty() {
        rows.push(common::empty_state("Nothing needs you.", dark));
    }
    card = card.children(rows);
    section("Needs you", vec![card], dark)
}

fn row_of_buttons(_dark: bool, k: &rune_kit::Kit, decide: (String, String)) -> El {
    let deny_pair = decide.clone();
    let approve_pair = decide.clone();
    rune::row()
        .key("decide")
        .gap(space::S2)
        .child(
            Button::new("Deny").variant(ButtonVariant::Outline).on_press(move |s: &mut App| {
                let (c, call) = deny_pair.clone();
                s.net.mutate(Mutation::Decide { conversation: c, call, approved: false, always: false }, "decide");
            }).build(k),
        )
        .child(
            Button::new("Approve").variant(ButtonVariant::Submit).on_press(move |s: &mut App| {
                let (c, call) = approve_pair.clone();
                s.net.mutate(Mutation::Decide { conversation: c, call, approved: true, always: false }, "decide");
            }).build(k),
        )
        .key(format!("decide-row:{}", decide.1))
}

fn parked_row(row: &serde_json::Value, id: &str, dark: bool, k: &rune_kit::Kit) -> El {
    let t = crate::theme::tokens(dark);
    let words = row.get("title").and_then(serde_json::Value::as_str).unwrap_or("A stuck engine task");
    let task_id = id.to_string();
    el()
        .key(format!("parked:{id}"))
        .w_full()
        .min_h(56.0)
        .px(space::S3)
        .py(space::S2)
        .gap(space::S3)
        .center_y()
        .radius(10.0)
        .fill(t.card)
        .border(1.0, t.hairline)
        .child(
            col()
                .gap(2.0)
                .grow(1.0)
                .min_w(0.0)
                .child(text(words.to_string()).font(ty::UI_MED).color(t.fg).max_lines(1))
                .child(text("Cut off by restarts; it never runs again by itself".to_string()).font(ty::META).color(t.muted_fg)),
        )
        .child(
            Button::new("Retry").variant(ButtonVariant::Outline).on_press(move |s: &mut App| {
                let id = task_id.clone();
                s.net.mutate(Mutation::ParkedRetry(id.clone()), &format!("retry:{id}"));
            }).build(k),
        )
}

fn tasks_sections(s: &App, dark: bool) -> El {
    let mut running: Vec<El> = Vec::new();
    let mut finished: Vec<El> = Vec::new();
    let now = common::now_millis();
    for task in &s.tasks {
        let title = task.title.clone().unwrap_or_else(|| task.prompt.clone());
        let bot = task.bot.as_ref().map(|b| s.bot_name(&b.profile_id)).unwrap_or_else(|| "a bot".into());
        let id = task.id.clone();
        let row = common::list_row(
            &task.id,
            title,
            Some(match task.status.as_str() {
                "running" => format!("{bot} · running · {}", task.last_step.clone().unwrap_or_default()),
                "queued" => format!("{bot} · queued"),
                "done" => format!("{bot} · done"),
                "failed" => format!("{bot} · failed"),
                _ => bot.clone(),
            }),
            None,
            move |s: &mut App| {
                s.net.fetch(Fetch::TaskActivity(id.clone()));
                crate::ui::open_task(s, id.clone());
            },
        );
        let fresh = now - task.created_at < 86_400.0 * 1000.0;
        if task.status == "running" || task.status == "queued" {
            running.push(row);
        } else if task.status == "done" && fresh {
            finished.push(row);
        }
    }
    let mut parts = vec![section("Working", vec![list_or_empty(running, "Nothing is working right now.", dark)], dark)];
    if !finished.is_empty() {
        parts.push(section("Finished today", vec![list_or_empty(finished, "No clean finishes in the last day.", dark)], dark));
    }
    col().key("tasks").gap(space::S6).children(parts)
}

fn list_or_empty(rows: Vec<El>, words: &str, dark: bool) -> El {
    if rows.is_empty() {
        return common::empty_state(words, dark);
    }
    common::list_card(dark).children(rows)
}

fn goals(s: &App, dark: bool) -> El {
    if !s.has("projects") {
        return section("Goals in motion", vec![common::skeleton(300.0, 56.0, dark)], dark);
    }
    let t = crate::theme::tokens(dark);
    let rows: Vec<El> = s
        .projects
        .iter()
        .map(|p| {
            let title = crate::net::types::row_str(p, "title");
            let status = crate::net::types::row_str(p, "status");
            common::list_row(
                &format!("goal:{}", crate::net::types::row_str(p, "id")),
                if title.is_empty() { "A goal".to_string() } else { title },
                (!status.is_empty()).then_some(status),
                None,
                |_| {},
            )
        })
        .collect();
    let _ = t;
    section("Goals in motion", vec![list_or_empty(rows, "No goals in motion.", dark)], dark)
}

fn files(s: &App, dark: bool) -> El {
    if !s.has("artifacts") {
        return section("Newest files", vec![common::skeleton(300.0, 56.0, dark)], dark);
    }
    let t = crate::theme::tokens(dark);
    let rows: Vec<El> = s
        .artifacts
        .iter()
        .take(8)
        .map(|a| {
            let source = a.source.as_ref().map(|src| {
                if src.main {
                    format!("from {}'s chat", s.bot_name(&src.bot_id))
                } else {
                    format!("from {}", src.title)
                }
            });
            let detail = match &source {
                Some(w) => format!("{} · {}", common::bytes_word(a.bytes), w),
                None => common::bytes_word(a.bytes),
            };
            let id = a.id.clone();
            common::list_row(
                &a.id,
                a.name.clone(),
                Some(detail),
                Some(text(common::ago(a.created_at)).font(ty::META).color(t.muted_fg)),
                move |s: &mut App| {
                    let id = id.clone();
                    crate::ui::open_file(s, id);
                },
            )
        })
        .collect();
    section("Newest files", vec![list_or_empty(rows, "No files yet.", dark)], dark)
}

fn section(title: &str, children: Vec<El>, dark: bool) -> El {
    col()
        .key(format!("sec:{}", title))
        .gap(space::S2)
        .child(common::section_label(title, dark))
        .children(children)
}

/// Owner words for a gated tool name (the lens's title stem).
pub fn tool_words(name: &str) -> String {
    match name {
        "bash" => "run a command".into(),
        "web_search" => "search the web".into(),
        "web_fetch" => "fetch a page".into(),
        "read_file" => "read a file".into(),
        "write_file" => "write a file".into(),
        "send_mail" => "send mail".into(),
        "secret_request" => "ask for a secret".into(),
        "ask_user_question" => "ask you a question".into(),
        "schedule_create" => "create a schedule".into(),
        "memory_write" => "write a memory".into(),
        other => format!("use {other}"),
    }
}
