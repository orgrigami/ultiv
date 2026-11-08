//! Every screen the routes dispatch to.

pub mod chat;
pub mod crew;
pub mod history;
pub mod now;
pub mod profile;
pub mod rooms;
pub mod routines;
pub mod settings;
pub mod team;
pub mod tools;

use crate::state::{App, Route};
use crate::ui::common::ty;
use rune::{el, text, El};

/// The home screen: the current bot's chat; onboarding when there are no bots.
pub fn chat_placeholder(s: &App, dark: bool) -> El {
    if s.profiles.is_empty() && s.has("profiles") {
        return onboarding(s, dark);
    }
    chat::view(s, dark)
}

/// Onboarding when there are no bots (routes/index.tsx).
fn onboarding(_s: &App, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    el()
        .key("onboarding")
        .w_full()
        .h_full()
        .center()
        .fill(t.background)
        .child(
            el()
                .key("onboard-card")
                .w(420.0)
                .padding(rune::tok::space::S6)
                .gap(rune::tok::space::S3)
                .radius(25.0)
                .fill(t.card)
                .border(1.0, t.hairline)
                .child(text("Make your first bot".to_string()).font(ty::TITLE).color(t.fg))
                .child(
                    text(
                        "A bot is one entity with its own persona, memory and vault scope. Create it here, or import one."
                            .to_string(),
                    )
                    .font(ty::UI)
                    .color(t.muted_fg),
                ),
        )
}

/// Navigate helpers shared by rows across screens.
pub fn go(app: &mut App, route: Route) {
    app.route = route;
}
