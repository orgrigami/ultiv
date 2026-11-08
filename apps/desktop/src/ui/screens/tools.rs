//! `/tools?tab=connectors|skills|vault`: the three tool panels on one page.

use crate::state::{App, ToolsTab};
use crate::ui::common::{self, ty};
use rune::tok::space;
use rune::{col, el, text, El};
use rune_kit::{Button, ButtonVariant};

pub fn view(s: &App, active: ToolsTab, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let k = crate::theme::kit(dark);
    let mut strip = rune::row().key("tool-tabs").gap(space::S1);
    for tab in [ToolsTab::Connectors, ToolsTab::Skills, ToolsTab::Vault] {
        let selected = tab == active;
        strip = strip.child(
            Button::new(tab.label())
                .variant(if selected { ButtonVariant::Contrast } else { ButtonVariant::Ghost })
                .on_press(move |s: &mut App| s.route = crate::state::Route::Tools(tab))
                .build(&k),
        );
    }
    let body = match active {
        ToolsTab::Connectors => connectors(s, dark),
        ToolsTab::Skills => skills(s, dark),
        ToolsTab::Vault => vault(s, dark),
    };
    el()
        .key("tools")
        .w_full()
        .h_full()
        .fill(t.background)
        .child(
            el()
                .key("tools-scroll")
                .w_full()
                .h_full()
                .min_h(0.0)
                .scroll(rune::ScrollSpec { stick_bottom: false })
                .child(
                    col()
                        .key("tools-page")
                        .w_full()
                        .padding(space::S6)
                        .gap(16.0)
                        .child(common::page_header("Tools", dark, vec![]))
                        .child(strip)
                        .child(body),
                ),
        )
}

fn connectors(s: &App, dark: bool) -> El {
    if !s.has("connectors") {
        return common::empty_state("Loading connectors…", dark);
    }
    let t = crate::theme::tokens(dark);
    if s.mcp.is_empty() {
        return common::empty_state("No connectors yet. Add one from the web client or the bot's ask.", dark);
    }
    common::list_card(dark).children(
        s.mcp
            .iter()
            .map(|r| {
                let name = crate::net::types::row_str(r, "name");
                let url = crate::net::types::row_str(r, "url");
                let status = crate::net::types::row_str(r, "status");
                common::list_row(
                    &format!("mcp:{}", crate::net::types::row_str(r, "id")),
                    if name.is_empty() { "A connector".to_string() } else { name },
                    Some(if url.is_empty() { status.clone() } else { format!("{url} · {status}") }),
                    None,
                    |_| {},
                )
            })
            .collect::<Vec<_>>(),
    )
    .key("connectors")
    .child(el().key("pad").h(0.0))
    .children(vec![text(String::new()).font(ty::META).color(t.muted_fg)])
}

fn skills(s: &App, dark: bool) -> El {
    if !s.has("skills") {
        return common::empty_state("Loading skills…", dark);
    }
    if s.skills.is_empty() {
        return common::empty_state("No skills yet.", dark);
    }
    common::list_card(dark).key("skills").children(
        s.skills
            .iter()
            .map(|r| {
                let name = crate::net::types::row_str(r, "name");
                let profile = crate::net::types::row_str(r, "profileId");
                let enabled = crate::net::types::row_bool(r, "enabled").unwrap_or(true);
                common::list_row(
                    &format!("skill:{}", crate::net::types::row_str(r, "id")),
                    if name.is_empty() { "A skill".to_string() } else { name },
                    Some(format!("{} · {}", crate_row_words(profile), if enabled { "on" } else { "off" })),
                    None,
                    |_| {},
                )
            })
            .collect::<Vec<_>>(),
    )
}

fn vault(s: &App, dark: bool) -> El {
    if !s.has("vault") {
        return common::empty_state("Loading the vault…", dark);
    }
    let t = crate::theme::tokens(dark);
    if s.vault.is_empty() {
        return common::empty_state("The vault is empty.", dark);
    }
    common::list_card(dark)
        .key("vault")
        .children(
            s.vault
                .iter()
                .map(|r| {
                    let named = crate::net::types::row_str(r, "name");
                    let name = if named.is_empty() { crate::net::types::row_str(r, "key") } else { named };
                    common::list_row(
                        &format!("vault:{}", crate::net::types::row_str(r, "id")),
                        if name.is_empty() { "A secret".to_string() } else { name },
                        Some("values stay hidden".to_string()),
                        Some(text("sealed".to_string()).font(ty::META).color(t.muted_fg)),
                        |_| {},
                    )
                })
                .collect::<Vec<_>>(),
        )
}

fn crate_row_words(profile: String) -> String {
    if profile.is_empty() {
        "shared".into()
    } else {
        profile
    }
}
