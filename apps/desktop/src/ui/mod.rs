//! The root view: gate → shell (rail + main screen + dock) → overlays.

pub mod common;
pub mod dock;
pub mod gate;
pub mod lens;
pub mod rail;
pub mod screens;
pub mod switcher;

use crate::state::{App, Gate, Route};
use common::{is_dark, ty};
use rune::{col, el, text, Cx, El};

/// The app's one view; everything dispatches from the state.
pub fn view(s: &App, cx: &mut Cx<App>) -> El {
    let dark = is_dark(s, cx);
    match &s.gate {
        Gate::Checking => checking(s, dark),
        Gate::SignIn { .. } => gate::view(s, dark),
        Gate::Ready => shell(s, cx, dark),
    }
}

fn checking(_s: &App, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    col()
        .key("checking")
        .w_full()
        .h_full()
        .center()
        .gap(12.0)
        .fill(t.background)
        .child(gate::brand_wordmark(dark))
        .child(text("Connecting…".to_string()).font(ty::UI).color(t.muted_fg))
}

fn shell(s: &App, cx: &mut Cx<App>, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let wide = cx.window_layout("shell").map(|r| r[2] >= 1024.0).unwrap_or(true);
    let mut main_row = rune::row()
        .key("shell-row")
        .w_full()
        .h_full()
        .min_h(0.0)
        .child(rail::view(s, dark))
        .child(
            el()
                .key("main")
                .grow(1.0)
                .min_w(0.0)
                .min_h(0.0)
                .h_full()
                .child(screen(s, cx, dark)),
        );
    if wide && !s.dock.is_empty() {
        main_row = main_row.child(dock::view(s, dark));
    }
    el()
        .key("shell")
        .w_full()
        .h_full()
        .fill(t.background)
        .child(main_row)
        .children(switcher::view(s, dark))
        .children(dock::fullscreen_view(s, dark))
        .children(toast(s, cx, dark))
}

fn screen(s: &App, cx: &mut Cx<App>, dark: bool) -> El {
    match &s.route {
        Route::Home | Route::Chat(_) => screens::chat_placeholder(s, dark),
        Route::Now => screens::now::view(s, dark),
        Route::Crew => screens::crew::view(s, dark),
        Route::Profile(id, tab) => screens::profile::view(s, cx, id, *tab, dark),
        Route::Team(id) => screens::team::view(s, id, dark),
        Route::Settings => screens::settings::view(s, dark),
        Route::Routines => screens::routines::view(s, dark),
        Route::History => screens::history::view(s, dark),
        Route::Rooms => screens::rooms::view(s, dark),
        Route::Tools(tab) => screens::tools::view(s, *tab, dark),
    }
}

/// Open a task in the work dock (a new tab, or the one already holding it).
pub fn open_task(s: &mut App, id: String) {
    open_dock(s, crate::state::DockTab::Task(id));
}

/// Open a file in the work dock.
pub fn open_file(s: &mut App, id: String) {
    open_dock(s, crate::state::DockTab::File(id));
}

/// Push a dock tab (max five; the oldest not being looked at gives way).
pub fn open_dock(s: &mut App, tab: crate::state::DockTab) {
    if let Some(i) = s.dock.iter().position(|t| t == &tab) {
        s.dock_active = i;
        return;
    }
    if s.dock.len() >= 5 {
        let evict = (0..s.dock.len()).find(|i| *i != s.dock_active).unwrap_or(0);
        s.dock.remove(evict);
        if s.dock_active > evict {
            s.dock_active -= 1;
        }
    }
    s.dock.push(tab.clone());
    s.dock_active = s.dock.len() - 1;
    dock::request(s, &tab);
}

fn toast(s: &App, cx: &mut Cx<App>, dark: bool) -> Vec<El> {
    let Some(words) = &s.toast else { return vec![] };
    // 2.5 s, like a quiet status word; cleared in poll.
    if common::now_millis() - s.toast_at.unwrap_or(0.0) > 2500.0 {
        return vec![];
    }
    let t = crate::theme::tokens(dark);
    let width = cx.window_layout("shell").map(|r| r[2]).unwrap_or(800.0);
    let side = ((width - 420.0) / 2.0).max(12.0);
    vec![el()
        .key("toast")
        .absolute(side, 12.0)
        .child(
            el()
                .key("toast-card")
                .w(420.0)
                .px(16.0)
                .py(10.0)
                .radius(10.0)
                .fill(t.popover)
                .border(1.0, t.hairline)
                .shadow(8.0, 24.0, t.fg.alpha(0.25))
                .child(text(words.clone()).font(ty::UI).color(t.fg)),
        )]
}
