//! `/tools?tab=connectors|skills|vault`: the three tool panels on one page.

use crate::net::endpoints::{Fetch, Mutation};
use crate::net::types::Row;
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
    let mut body = match active {
        ToolsTab::Connectors => connectors(s, dark),
        ToolsTab::Skills => skills(s, dark),
        ToolsTab::Vault => vault(s, dark),
    };
    if active == ToolsTab::Skills {
        if let Some(detail) = skill_detail(s, dark) {
            body = col().key("skills-with-detail").gap(space::S3).child(detail).child(body);
        }
    }
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

/// The skills overview: built-ins, one section per bot with its rows, and
/// the open proposals each bot parks with a verdict pair.
fn skills(s: &App, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let k = crate::theme::kit(dark);
    let Some(overview) = &s.skills else {
        return common::empty_state("Loading skills…", dark);
    };
    let mut parts: Vec<El> = Vec::new();
    if let Some(builtins) = overview.get("builtins").and_then(serde_json::Value::as_array) {
        parts.push(skill_section(s, "Built in", "spriessen", builtins, dark));
    }
    if let Some(namespaces) = overview.get("profiles").and_then(serde_json::Value::as_array) {
        for ns in namespaces {
            let profile = crate::net::types::row_str(ns, "profile");
            let name = crate::net::types::row_str(ns, "profileName");
            if let Some(rows) = ns.get("skills").and_then(serde_json::Value::as_array) {
                parts.push(skill_section(s, &name, &profile, rows, dark));
            }
            let parked = s.proposals.get(&profile).cloned().unwrap_or_default();
            let open: Vec<Row> = parked.iter().filter(|p| crate::net::types::row_str(p, "status") == "open").cloned().collect();
            for proposal in open {
                let pid = crate::net::types::row_str(&proposal, "id");
                let words = crate::net::types::row_str(&proposal, "summary");
                let accept_pid = pid.clone();
                let reject_pid = pid.clone();
                let accept_profile = profile.clone();
                let reject_profile = profile.clone();
                parts.push(
                    el()
                        .key(format!("proposal:{pid}"))
                        .w_full()
                        .px(space::S3)
                        .py(space::S2)
                        .gap(space::S2)
                        .radius(10.0)
                        .fill(t.live.alpha(0.1))
                        .center_y()
                        .child(
                            col()
                                .gap(2.0)
                                .grow(1.0)
                                .min_w(0.0)
                                .child(text("A skill it learned wants a verdict".to_string()).font(ty::UI_MED).color(t.fg))
                                .children((!words.is_empty()).then(|| text(words).font(ty::META).color(t.muted_fg).max_lines(2))),
                        )
                        .child(
                            Button::new("Reject").variant(ButtonVariant::Outline).on_press(move |s: &mut App| {
                                let (profile, id) = (reject_profile.clone(), reject_pid.clone());
                                let tag = format!("skill-proposals:{profile}");
                                s.net.mutate(Mutation::SkillVerdict { profile, id, accept: false }, &tag);
                            }).build(&k),
                        )
                        .child(
                            Button::new("Keep it").variant(ButtonVariant::Submit).on_press(move |s: &mut App| {
                                let (profile, id) = (accept_profile.clone(), accept_pid.clone());
                                let tag = format!("skill-proposals:{profile}");
                                s.net.mutate(Mutation::SkillVerdict { profile, id, accept: true }, &tag);
                            }).build(&k),
                        ),
                );
            }
        }
    }
    if parts.is_empty() {
        return common::empty_state("No skills yet.", dark);
    }
    col().key("skills").gap(16.0).children(parts)
}

/// One namespace's rows; a row press opens the skill's detail.
fn skill_section(_s: &App, title: &str, profile: &str, rows: &[Row], dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    if rows.is_empty() {
        return col()
            .key(format!("sec:{title}"))
            .gap(space::S2)
            .child(common::section_label(title, dark))
            .child(common::empty_state("Nothing learned yet.", dark));
    }
    let cards = common::list_card(dark).children(
        rows.iter()
            .map(|r| {
                let name = crate::net::types::row_str(r, "name");
                let enabled = crate::net::types::row_bool(r, "enabled").unwrap_or(true);
                let detail_profile = profile.to_string();
                let detail_name = name.clone();
                common::list_row(
                    &format!("{profile}:{name}"),
                    if name.is_empty() { "A skill".to_string() } else { name },
                    Some(if enabled { "on".into() } else { "off".into() }),
                    Some(text(if enabled { "on" } else { "off" }.to_string()).font(ty::META).color(if enabled { t.success } else { t.muted_fg })),
                    move |s: &mut App| {
                        let (profile, name) = (detail_profile.clone(), detail_name.clone());
                        s.net.fetch(Fetch::SkillDetail { profile, name });
                    },
                )
            })
            .collect::<Vec<_>>(),
    );
    col().key(format!("sec:{title}")).gap(space::S2).child(common::section_label(title, dark)).child(cards)
}

/// The opened skill's detail: its body, and the enable switch.
fn skill_detail(s: &App, dark: bool) -> Option<El> {
    let t = crate::theme::tokens(dark);
    let k = crate::theme::kit(dark);
    let Some((profile, name, detail)) = &s.skill_detail else { return None };
    let body = crate::net::types::row_str(detail, "body");
    let enabled = crate::net::types::row_bool(detail, "enabled").unwrap_or(true);
    let toggle_profile = profile.clone();
    let toggle_name = name.clone();
    Some(
        el()
            .key("skill-detail")
            .w_full()
            .padding(space::S3)
            .radius(15.0)
            .fill(t.card)
            .border(1.0, t.hairline)
            .child(
                col()
                    .key("skill-detail-body")
                    .gap(space::S2)
                    .child(
                        rune::row()
                            .key("detail-head")
                            .gap(space::S2)
                            .center_y()
                            .child(text(name.clone()).font(ty::UI_MED).color(t.fg))
                            .child(el().key("space").grow(1.0))
                            .child(
                                Button::new(if enabled { "Turn off" } else { "Turn on" })
                                    .variant(ButtonVariant::Outline)
                                    .on_press(move |s: &mut App| {
                                        let (profile, name) = (toggle_profile.clone(), toggle_name.clone());
                                        let tag = format!("skill:{profile}:{name}");
                                        s.net.mutate(Mutation::SkillSet { profile, name, enabled: !enabled }, &tag);
                                    })
                                    .build(&k),
                            ),
                    )
                    .child(text(body).font(ty::MONO).color(t.fg)),
            ),
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
