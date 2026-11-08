//! The work dock: floating tabs beside the chat (task, file, memory, Needs
//! you, room), five at most, the strip switching them — `components/work-pane.tsx`.

use crate::net::endpoints::Fetch;
use crate::state::{App, DockTab};
use crate::ui::common::{self, ty};
use rune::tok::space;
use rune::{col, el, text, El};
use rune_kit::IconButton;

/// The dock over the main pane, or nothing when it holds no tabs.
pub fn view(s: &App, dark: bool) -> El {
    if s.dock.is_empty() {
        return col().key("dock-none");
    }
    let t = crate::theme::tokens(dark);
    let k = crate::theme::kit(dark);
    let mut strip = rune::row().key("dock-strip").gap(space::S1);
    for (i, tab) in s.dock.iter().enumerate() {
        let selected = i == s.dock_active;
        let title = tab_title(s, tab);
        strip = strip.child(
            el()
                .key(format!("dock-tab:{i}"))
                .h(32.0)
                .px(space::S3)
                .gap(space::S2)
                .center_y()
                .radius(10.0)
                .fill(if selected { t.card } else { Color::TRANSPARENT })
                .border(1.0, if selected { t.hairline } else { Color::TRANSPARENT })
                .child(text(title).font(ty::META_MED).color(t.fg).max_lines(1))
                .focusable(true)
                .on_press(move |s: &mut App| s.dock_active = i),
        );
    }
    let active = s.dock.get(s.dock_active).cloned();
    let body = match active {
        Some(tab) => tab_body(s, &tab, dark),
        None => common::empty_state("Nothing open.", dark),
    };
    el()
        .key("dock")
        .w(380.0)
        .h_full()
        .ml(space::S3)
        .padding(space::S2)
        .radius(25.0)
        .fill(t.sidebar)
        .border(1.0, t.hairline)
        .child(
            col()
                .key("dock-inner")
                .w_full()
                .h_full()
                .min_h(0.0)
                .gap(space::S2)
                .child(
                    rune::row()
                        .key("dock-head")
                        .gap(space::S1)
                        .child(strip)
                        .child(IconButton::new(&CLOSE).label("Close tab").on_press(|s: &mut App| close_active(s)).build(&k)),
                )
                .child(el().key("dock-rule").w_full().h(1.0).fill(t.hairline))
                .child(el().key("dock-body").grow(1.0).min_h(0.0).child(
                    el().key("dock-scroll").w_full().h_full().min_h(0.0).scroll(rune::ScrollSpec { stick_bottom: false }).child(body),
                )),
        )
}

pub static CLOSE: rune::Icon = rune::Icon {
    name: "sp-close",
    view: 16.0,
    body: r#"<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>"#,
};

use rune::Color;

fn close_active(s: &mut App) {
    if s.dock.is_empty() {
        return;
    }
    s.dock.remove(s.dock_active);
    if s.dock_active >= s.dock.len() {
        s.dock_active = s.dock.len().saturating_sub(1);
    }
}

fn tab_title(s: &App, tab: &DockTab) -> String {
    match tab {
        DockTab::Task(id) => s
            .tasks
            .iter()
            .find(|t| &t.id == id)
            .map(|t| t.title.clone().unwrap_or_else(|| t.prompt.clone()))
            .unwrap_or_else(|| "Task".into()),
        DockTab::File(id) => s
            .artifacts
            .iter()
            .find(|a| &a.id == id)
            .map(|a| a.name.clone())
            .unwrap_or_else(|| "File".into()),
        DockTab::Memory { name, .. } => format!("Memory · {name}"),
        DockTab::Needs => "Needs you".into(),
        DockTab::Room(id) => s
            .rooms
            .iter()
            .find(|r| crate::net::types::row_str(r, "id") == *id)
            .map(|r| crate::net::types::row_str(r, "name"))
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "Talk".into()),
    }
}

fn tab_body(s: &App, tab: &DockTab, dark: bool) -> El {
    match tab {
        DockTab::Task(id) => task_body(s, id, dark),
        DockTab::File(id) => file_body(s, id, dark),
        DockTab::Memory { .. } => common::empty_state("Memory search opens with the memory panel.", dark),
        DockTab::Needs => needs_body(s, dark),
        DockTab::Room(_) => common::empty_state("The talk renders in Bot talks.", dark),
    }
}

fn task_body(s: &App, id: &str, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let Some(task) = s.tasks.iter().find(|t| t.id == id) else {
        return common::empty_state("That task is gone.", dark);
    };
    let status_color = match task.status.as_str() {
        "running" => t.live,
        "failed" => t.deny,
        "done" => t.success,
        _ => t.muted_fg,
    };
    let title = task.title.clone().unwrap_or_else(|| task.prompt.clone());
    col()
        .key("task-body")
        .gap(space::S3)
        .child(
            rune::row()
                .key("task-head")
                .gap(space::S2)
                .center_y()
                .child(text(task.status.clone()).font(ty::META_MED).color(status_color))
                .child(text(title).font(ty::UI_MED).color(t.fg).max_lines(2).grow(1.0)),
        )
        .children(task.last_step.clone().map(|step| {
            text(format!("Now: {step}")).font(ty::UI).color(t.muted_fg).max_lines(3)
        }))
        .children(task.updates.as_ref().map(|updates| {
            col()
                .key("updates")
                .gap(space::S1)
                .children(
                    updates
                        .iter()
                        .map(|u| text(u.text.clone()).font(ty::UI).color(t.fg).max_lines(4))
                        .collect::<Vec<_>>(),
                )
        }))
        .children(task.result.clone().map(|r| {
            el()
                .key("result")
                .w_full()
                .padding(space::S3)
                .radius(10.0)
                .fill(t.card)
                .border(1.0, t.hairline)
                .child(text(r).font(ty::UI).color(t.fg))
        }))
        .child(
            {
                let task_id = id.to_string();
                rune_kit::Button::new("Stop")
                    .variant(rune_kit::ButtonVariant::Outline)
                    .on_press(move |s: &mut App| {
                        s.net.mutate(crate::net::endpoints::Mutation::TaskCancel(task_id.clone()), &format!("cancel:{task_id}"));
                    })
                    .build(&crate::theme::kit(dark))
            },
        )
}

fn file_body(s: &App, id: &str, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let Some(meta) = s.artifacts.iter().find(|a| a.id == id) else {
        return common::empty_state("That file is gone.", dark);
    };
    let previewable = meta.mime.starts_with("text/") || meta.mime == "application/json" || meta.mime.contains("csv");
    let key = format!("file:{id}");
    if previewable && !s.has(&key) {
        return common::empty_state("Open again to load it.", dark);
    }
    let words = s
        .previews
        .get(id)
        .cloned()
        .unwrap_or_else(|| "(no preview for this kind)".into());
    col()
        .key("file-body")
        .gap(space::S2)
        .child(
            rune::row()
                .key("file-meta")
                .gap(space::S2)
                .child(text(meta.name.clone()).font(ty::UI_MED).color(t.fg).max_lines(1).grow(1.0))
                .child(text(common::bytes_word(meta.bytes)).font(ty::MONO).color(t.muted_fg)),
        )
        .child(text(words).font(ty::MONO).color(t.fg))
}

fn needs_body(s: &App, dark: bool) -> El {
    let count = s.needs_count();
    if count == 0 {
        return common::empty_state("Nothing needs you.", dark);
    }
    col()
        .key("needs-body")
        .gap(space::S2)
        .child(text(format!("{count} thing{} need you", if count == 1 { "" } else { "s" })).font(ty::UI_MED).color(crate::theme::tokens(dark).signal))
        .child(common::empty_state("Decide them from Now, where the cards live.", dark))
}

/// A fetch the dock asks for when a file tab mounts.
pub fn request(s: &mut App, tab: &DockTab) {
    if let DockTab::File(id) = tab {
        let key = format!("file:{id}");
        if !s.has(&key) {
            if let Some(meta) = s.artifacts.iter().find(|a| &a.id == id) {
                let previewable =
                    meta.mime.starts_with("text/") || meta.mime == "application/json" || meta.mime.contains("csv");
                if previewable {
                    s.net.fetch(Fetch::ArtifactText(id.clone()));
                }
            }
        }
    }
    if let DockTab::Task(id) = tab {
        s.net.fetch(Fetch::TaskActivity(id.clone()));
    }
}
