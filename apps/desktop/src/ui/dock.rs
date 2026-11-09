//! The work dock: floating tabs beside the chat (task, file, memory, Needs
//! you, room), five at most, the strip switching them — `components/work-pane.tsx`.

use crate::net::endpoints::Fetch;
use crate::net::types::ArtifactInfo;
use crate::state::{App, DockTab};
use crate::ui::common::{self, ty};
use rune::tok::space;
use rune::{col, el, text, El};
use rune_kit::{Button, ButtonVariant, IconButton};

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
        DockTab::Takeover(_) => "Live view".into(),
    }
}

fn tab_body(s: &App, tab: &DockTab, dark: bool) -> El {
    match tab {
        DockTab::Task(id) => task_body(s, id, dark),
        DockTab::File(id) => file_body(s, id, dark),
        DockTab::Memory { .. } => common::empty_state("Memory search opens with the memory panel.", dark),
        DockTab::Needs => needs_body(s, dark),
        DockTab::Room(_) => common::empty_state("The talk renders in Bot talks.", dark),
        DockTab::Takeover(id) => cast_body(s, id, dark),
    }
}

/// The live view: the latest frame (tap to act), the type field, the address
/// bar, and the Finish / Step away buttons.
fn cast_body(s: &App, id: &str, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let k = crate::theme::kit(dark);
    let Some(cast) = s.cast.as_ref().filter(|c| c.id == id) else {
        return common::empty_state("Connecting to the live view…", dark);
    };
    let mut body: Vec<El> = Vec::new();
    if !cast.title.is_empty() && cast.title != "null" {
        body.push(text(cast.title.trim_matches('"').to_string()).font(ty::UI_MED).color(t.fg).max_lines(1));
    }
    if !cast.url.is_empty() && cast.url != "null" {
        body.push(text(cast.url.trim_matches('"').to_string()).font(ty::MONO).color(t.muted_fg).max_lines(1));
    }
    // The frame: Fit into a 300-tall box; a drag press taps at the page point.
    if let (Some(image), true) = (&cast.image, cast.w > 0.0 && cast.h > 0.0) {
        let (fw, fh) = (cast.w, cast.h);
        let tap_id = id.to_string();
        body.push(
            el()
                .key("cast-frame")
                .w_full()
                .h(300.0)
                .radius(10.0)
                .clip_rounded(10.0)
                .fill(t.card)
                .border(1.0, t.hairline)
                .child(el().key("cast-img").w_full().h_full().pixels_fit(image.pixels(), rune::SurfaceFit::Fit))
                .on_drag(move |s: &mut App, drag: &mut rune::Drag, tx| {
                    if drag.phase == rune::Phase::Down {
                        // Fit inside the box; convert the local point to page pixels.
                        let bw = drag.w.max(1.0) as f64;
                        let bh = drag.h.max(1.0) as f64;
                        let scale = (bw / fw).min(bh / fh).max(0.0001);
                        let (dw, dh) = (fw * scale, fh * scale);
                        let px = (((drag.x as f64) - (bw - dw) / 2.0) / scale).clamp(0.0, fw);
                        let py = (((drag.y as f64) - (bh - dh) / 2.0) / scale).clamp(0.0, fh);
                        let _ = s;
                        let _ = tx;
                        let _ = tap_id;
                        s.net.cast_act(
                            tap_id.clone(),
                            serde_json::json!({ "a": "tap", "x": px, "y": py }),
                            format!("cast:{tap_id}"),
                        );
                    }
                }),
        );
    } else {
        body.push(common::empty_state(if cast.ready { "Waiting for the first frame…" } else { "Connecting…" }, dark));
    }
    // The type field + its send.
    let type_id = id.to_string();
    body.push(
        rune::row()
            .key("cast-type")
            .gap(space::S2)
            .child(
                rune_kit::TextInput::new(&cast.typed)
                    .placeholder("Type into the page")
                    .on_edit(|s: &mut App| match s.cast.as_mut() {
                        Some(c) => &mut c.typed,
                        None => &mut s.scratch_edit,
                    })
                    .build(&k),
            )
            .child(
                Button::new("Send")
                    .variant(ButtonVariant::Outline)
                    .on_press(move |s: &mut App| {
                        let type_id = type_id.clone();
                        let Some(cast) = s.cast.as_mut() else { return };
                        if cast.id != type_id {
                            return;
                        }
                        let words = cast.typed.text.clone();
                        if words.is_empty() {
                            return;
                        }
                        cast.typed = rune::TextEdit::new(String::new());
                        s.net.cast_act(
                            type_id.clone(),
                            serde_json::json!({ "a": "type", "text": words }),
                            format!("cast:{type_id}"),
                        );
                    })
                    .build(&k),
            ),
    );
    // The address bar + reload.
    let nav_id = id.to_string();
    body.push(
        rune::row()
            .key("cast-nav")
            .gap(space::S2)
            .child(
                rune_kit::TextInput::new(&rune::TextEdit::new(String::new()))
                    .placeholder("Navigate to a URL")
                    .on_edit(|s: &mut App| match s.cast.as_mut() {
                        Some(c) => &mut c.nav,
                        None => &mut s.scratch_edit,
                    })
                    .build(&k),
            )
            .child({
                let nav_id = nav_id.clone();
                Button::new("Go").variant(ButtonVariant::Outline).on_press(move |s: &mut App| {
                    let nav_id = nav_id.clone();
                    let Some(cast) = s.cast.as_ref() else { return };
                    let url = cast.nav.text.trim().to_string();
                    if url.is_empty() {
                        return;
                    }
                    s.net.cast_act(
                        nav_id.clone(),
                        serde_json::json!({ "a": "nav", "url": url }),
                        format!("cast:{nav_id}"),
                    );
                })
                .build(&k)
            })
            .child({
                let nav_id = nav_id.clone();
                Button::new("Reload").variant(ButtonVariant::Ghost).on_press(move |s: &mut App| {
                    let nav_id = nav_id.clone();
                    s.net.cast_act(nav_id.clone(), serde_json::json!({ "a": "reload" }), format!("cast:{nav_id}"));
                })
                .build(&k)
            }),
    );
    // Finish (done with it) or Step away (the bot keeps it).
    let finish_id = id.to_string();
    let cancel_id = id.to_string();
    body.push(
        rune::row()
            .key("cast-actions")
            .gap(space::S2)
            .child(
                Button::new("Step away").variant(ButtonVariant::Outline).on_press(move |s: &mut App| {
                    let cancel_id = cancel_id.clone();
                    s.net.mutate(crate::net::endpoints::Mutation::TakeoverCancel(cancel_id.clone()), &format!("takeover:{cancel_id}"));
                }).build(&k),
            )
            .child(
                Button::new("Done with it").variant(ButtonVariant::Submit).on_press(move |s: &mut App| {
                    let finish_id = finish_id.clone();
                    s.net.mutate(crate::net::endpoints::Mutation::TakeoverFinish(finish_id.clone()), &format!("takeover:{finish_id}"));
                    if s.cast.as_ref().map(|c| c.id == finish_id).unwrap_or(false) {
                        s.cast = None;
                    }
                }).build(&k),
            ),
    );
    col().key("cast-body").gap(space::S2).children(body)
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
                    "tool" | "tool-error" => crate::ui::screens::chat::tool_row(s, key, m, dark),
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
        .center_y()
        .child(text(meta.name.clone()).font(ty::UI_MED).color(t.fg).max_lines(1).grow(1.0))
        .child(text(common::bytes_word(meta.bytes)).font(ty::MONO).color(t.muted_fg))
        .children(toolbar(s, meta, dark));
    let body = if s.fullscreen == Some(meta.id.clone()) {
        // The inline body steps aside while fullscreen plays.
        common::empty_state("In fullscreen — close it to come back.", dark)
    } else {
        preview(s, meta, dark)
    };
    col().key("file-body").gap(space::S2).child(head).child(body)
}

/// The one toolbar row: Preview|Source for markdown, wrap for text, copy,
/// download, fullscreen. Wrap remembers per app run, like the web's
/// per-device memory.
fn toolbar(s: &App, meta: &ArtifactInfo, dark: bool) -> Vec<El> {
    let k = crate::theme::kit(dark);
    let mut tools: Vec<El> = Vec::new();
    let is_markdown = meta.mime.contains("markdown") || meta.name.ends_with(".md");
    let is_text = meta.mime.starts_with("text/") || meta.mime == "application/json";
    if is_markdown {
        let viewing_source = s.preview_source.contains(&meta.id);
        let id = meta.id.clone();
        tools.push(
            rune_kit::Button::new(if viewing_source { "Preview" } else { "Source" })
                .variant(rune_kit::ButtonVariant::Ghost)
                .on_press(move |s: &mut App| {
                    let id = id.clone();
                    if s.preview_source.contains(&id) {
                        s.preview_source.remove(&id);
                    } else {
                        s.preview_source.insert(id);
                    }
                })
                .build(&k),
        );
    }
    if is_text && !is_markdown {
        let wrapping = s.preview_wrap.contains(&meta.id);
        let id = meta.id.clone();
        tools.push(
            rune_kit::Button::new(if wrapping { "No wrap" } else { "Wrap" })
                .variant(rune_kit::ButtonVariant::Ghost)
                .on_press(move |s: &mut App| {
                    let id = id.clone();
                    if s.preview_wrap.contains(&id) {
                        s.preview_wrap.remove(&id);
                    } else {
                        s.preview_wrap.insert(id);
                    }
                })
                .build(&k),
        );
    }
    tools.push(
        rune_kit::Button::new("Copy")
            .variant(rune_kit::ButtonVariant::Ghost)
            .on_press_tx({
                let words = s.previews.get(&meta.id).cloned().unwrap_or_default();
                move |s: &mut App, tx| {
                    let _ = s;
                    if !words.is_empty() {
                        tx.copy(words.clone());
                    }
                }
            })
            .build(&k),
    );
    tools.push(
        rune_kit::Button::new("Download")
            .variant(rune_kit::ButtonVariant::Ghost)
            .on_press({
                let id = meta.id.clone();
                let name = meta.name.clone();
                move |s: &mut App| {
                    let (id, name) = (id.clone(), name.clone());
                    s.net.download(id, name);
                }
            })
            .build(&k),
    );
    if is_markdown || is_text || meta.mime.starts_with("image/") {
        let id = meta.id.clone();
        let open = s.fullscreen != Some(meta.id.clone());
        tools.push(
            rune_kit::Button::new(if open { "Fullscreen" } else { "Close" })
                .variant(rune_kit::ButtonVariant::Ghost)
                .on_press(move |s: &mut App| {
                    let id = id.clone();
                    s.fullscreen = if open { Some(id) } else { None };
                })
                .build(&k),
        );
    }
    tools
}

/// The fullscreen overlay: one preview over the whole window, with Close.
pub fn fullscreen_view(s: &App, dark: bool) -> Option<El> {
    let id = s.fullscreen.clone()?;
    let meta = s.artifacts.iter().find(|a| a.id == id)?;
    let t = crate::theme::tokens(dark);
    let k = crate::theme::kit(dark);
    let close_id = id.clone();
    Some(
        el()
            .key("fullscreen")
            .absolute(0.0, 0.0)
            .w_full()
            .h_full()
            .fill(t.background.alpha(0.985))
            .child(
                col()
                    .key("fullscreen-inner")
                    .w_full()
                    .h_full()
                    .padding(16.0)
                    .gap(space::S3)
                    .child(
                        rune::row()
                            .key("fullscreen-head")
                            .gap(space::S2)
                            .center_y()
                            .child(text(meta.name.clone()).font(ty::UI_MED).color(t.fg).grow(1.0))
                            .child(
                                rune_kit::Button::new("Close")
                                    .variant(rune_kit::ButtonVariant::Outline)
                                    .on_press(move |s: &mut App| {
                                        let close_id = close_id.clone();
                                        if s.fullscreen == Some(close_id) {
                                            s.fullscreen = None;
                                        }
                                    })
                                    .build(&k),
                            ),
                    )
                    .child(
                        el()
                            .key("fullscreen-body")
                            .grow(1.0)
                            .min_h(0.0)
                            .w_full()
                            .scroll(rune::ScrollSpec { stick_bottom: false })
                            .child(preview(s, meta, dark)),
                    ),
            ),
    )
}

/// One body per kind: images decode through the cache, CSV/TSV draw a table,
/// markdown renders (or its source), text wraps or not, the rest say so.
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
        let is_markdown = mime.contains("markdown") || meta.name.ends_with(".md");
        let viewing_source = s.preview_source.contains(&meta.id);
        if is_markdown && !viewing_source {
            let k = crate::theme::kit(dark);
            return rune_kit::Markdown::new(words).build(&k);
        }
        let wrapping = s.preview_wrap.contains(&meta.id);
        let mut card = el()
            .key("text-preview")
            .w_full()
            .padding(space::S3)
            .radius(10.0)
            .fill(t.card)
            .border(1.0, t.hairline);
        if wrapping {
            card = card.child(text(words).font(ty::UI).color(t.fg));
        } else {
            card = card.child(text(words).font(ty::MONO).color(t.fg));
        }
        return card;
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
        Some(image) if !image.is_ready() => common::empty_state("Decoding the image…", dark),
        Some(image) => match image.error() {
            Some(err) => {
                let why = err.to_string();
                common::empty_state(&format!("That image didn't decode: {why}"), dark)
            }
            None => match image.size() {
                Some(_) => el()
                    .key("image-preview")
                    .w_full()
                    .h(300.0)
                    .radius(10.0)
                    .clip_rounded(10.0)
                    .fill(t.card)
                    .child(el().key("img").w_full().h_full().pixels_fit(image.pixels(), rune::SurfaceFit::Fit)),
                None => common::empty_state("Decoding the image…", dark),
            },
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
    if let DockTab::Takeover(id) = tab {
        let fresh = s.cast.as_ref().map(|c| c.id != *id).unwrap_or(true);
        if fresh {
            s.cast = Some(crate::state::Cast::new(id.clone()));
            s.net.cast(id.clone());
        }
    }
}
