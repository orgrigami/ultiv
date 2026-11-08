//! The work dock: floating tabs beside the chat (task, file, memory, Needs
//! you, room), five at most, the strip switching them — `components/work-pane.tsx`.

use crate::net::endpoints::Fetch;
use crate::net::types::ArtifactInfo;
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
    let head = rune::row()
        .key("task-head")
        .gap(space::S2)
        .center_y()
        .child(text(task.status.clone()).font(ty::META_MED).color(status_color))
        .child(text(title).font(ty::UI_MED).color(t.fg).max_lines(2).grow(1.0))
        .child(stop_button(s, id, dark));
    let timeline = s.activities.get(id);
    let steps: Vec<El> = match timeline {
        None => vec![common::skeleton(240.0, 20.0, dark)],
        Some(rows) if rows.is_empty() => vec![common::empty_state("No steps yet.", dark)],
        Some(rows) => rows
            .iter()
            .enumerate()
            .map(|(i, m)| {
                let key = format!("step:{i}");
                match m.role.as_str() {
                    "user" | "owner" => crate::ui::screens::chat::owner_row(s, key, m, dark),
                    "tool" | "tool-error" => crate::ui::screens::chat::tool_row(key, m, dark),
                    "note" | "thinking" => crate::ui::screens::chat::quiet_row(key, m, dark),
                    _ => crate::ui::screens::chat::bot_row(key, m, dark),
                }
            })
            .collect(),
    };
    col()
        .key("task-body")
        .gap(space::S3)
        .child(head)
        .children(task.last_step.clone().map(|step| {
            text(format!("Now: {step}")).font(ty::UI).color(t.muted_fg).max_lines(3)
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
        .child(common::hairline(dark))
        .children(steps)
}

/// The dock's own Stop, wired to the task cancel route.
fn stop_button(_s: &App, id: &str, dark: bool) -> El {
    let task_id = id.to_string();
    rune_kit::Button::new("Stop")
        .variant(rune_kit::ButtonVariant::Outline)
        .on_press(move |s: &mut App| {
            s.net.mutate(
                crate::net::endpoints::Mutation::TaskCancel(task_id.clone()),
                &format!("cancel:{task_id}"),
            );
        })
        .build(&crate::theme::kit(dark))
}

fn file_body(s: &App, id: &str, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let Some(meta) = s.artifacts.iter().find(|a| a.id == id) else {
        return common::empty_state("That file is gone.", dark);
    };
    let head = rune::row()
        .key("file-meta")
        .gap(space::S2)
        .child(text(meta.name.clone()).font(ty::UI_MED).color(t.fg).max_lines(1).grow(1.0))
        .child(text(common::bytes_word(meta.bytes)).font(ty::MONO).color(t.muted_fg));
    col().key("file-body").gap(space::S2).child(head).child(preview(s, meta, dark))
}

/// One body per kind: images decode through the cache, CSV/TSV draw a table,
/// text kinds render mono, the rest say so plainly.
fn preview(s: &App, meta: &ArtifactInfo, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let mime = meta.mime.as_str();
    if mime.starts_with("image/") {
        return image_preview(s, &meta.id, dark);
    }
    if mime.contains("csv") || mime.contains("tab-separated") {
        return table_preview(s, &meta.id, dark);
    }
    if mime.starts_with("text/") || mime == "application/json" {
        let words = s.previews.get(&meta.id).cloned().unwrap_or_default();
        return el()
            .key("text-preview")
            .w_full()
            .padding(space::S3)
            .radius(10.0)
            .fill(t.card)
            .border(1.0, t.hairline)
            .child(text(words).font(ty::MONO).color(t.fg));
    }
    common::empty_state("No preview for this kind.", dark)
}

fn image_preview(s: &App, id: &str, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let key = format!("img:{id}");
    if !s.has(&key) {
        return common::empty_state("Loading the image…", dark);
    }
    match s.images.get(id) {
        Some(image) => match image.size() {
            Some(_) => el()
                .key("image-preview")
                .w_full()
                .h(300.0)
                .radius(10.0)
                .clip_rounded(10.0)
                .fill(t.card)
                .child(el().key("img").w_full().h_full().pixels_fit(image.pixels(), rune::SurfaceFit::Fit)),
            None => common::empty_state("That image has no size.", dark),
        },
        None => common::empty_state("That image didn't decode.", dark),
    }
}

/// CSV/TSV as a table: the header row bold, row numbers in mono, the first
/// 40 rows (the web's table view is its own pane; this is the dock's cut).
fn table_preview(s: &App, id: &str, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let Some(text_body) = s.previews.get(id) else {
        return common::empty_state("Loading the table…", dark);
    };
    let delimiter = if text_body.contains('\t') && !text_body.contains(',') { '\t' } else { ',' };
    let mut rows: Vec<El> = Vec::new();
    for (i, line) in text_body.lines().take(41).enumerate() {
        let cells: Vec<&str> = line.split(delimiter).collect();
        let font = if i == 0 { ty::UI_MED } else { ty::UI };
        let color = if i == 0 { t.fg } else { t.muted_fg };
        let mut row = rune::row().key(format!("row:{i}")).gap(space::S2).center_y().child(
            text(i.to_string()).font(ty::MONO).color(t.muted_fg).w(28.0),
        );
        for (c, cell) in cells.iter().take(6).enumerate() {
            row = row.child(text(cell.to_string()).font(font).color(color).max_lines(1).min_w(60.0).key(format!("c{c}")));
        }
        rows.push(row);
    }
    el().key("table-preview").w_full().padding(space::S2).radius(10.0).fill(t.card).border(1.0, t.hairline)
        .child(col().key("table-rows").gap(space::S1).children(rows))
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
                let mime = meta.mime.as_str();
                if mime.starts_with("image/") {
                    let key = format!("img:{id}");
                    if !s.has(&key) {
                        s.net.fetch(Fetch::ArtifactBytes(id.clone()));
                    }
                    return;
                }
                let previewable =
                    mime.starts_with("text/") || mime == "application/json" || mime.contains("csv");
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
