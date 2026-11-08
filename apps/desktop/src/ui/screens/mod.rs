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
use rune::{col, text, El};

/// The home screen: the current bot's chat; onboarding when there are no bots.
pub fn chat_placeholder(s: &App, dark: bool) -> El {
    if s.profiles.is_empty() && s.has("profiles") {
        return onboarding(s, dark);
    }
    chat::view(s, dark)
}

/// Onboarding when there are no bots (routes/index.tsx): the create form.
fn onboarding(s: &App, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let k = crate::theme::kit(dark);
    col()
        .key("onboarding")
        .w_full()
        .h_full()
        .center()
        .fill(t.background)
        .child(
            col()
                .key("onboard-card")
                .w(420.0)
                .padding(rune::tok::space::S6)
                .gap(rune::tok::space::S3)
                .radius(25.0)
                .fill(t.card)
                .border(1.0, t.hairline)
                .child(crate::ui::gate::brand_wordmark(dark))
                .child(text("Make your first bot".to_string()).font(ty::TITLE).color(t.fg))
                .child(
                    text(
                        "A bot is one entity with its own persona, memory and vault scope. Name it; give it words after."
                            .to_string(),
                    )
                    .font(ty::UI)
                    .color(t.muted_fg),
                )
                .child(
                    rune_kit::TextInput::new(&s.onboard_name)
                        .placeholder("Its name")
                        .on_edit(|s: &mut App| &mut s.onboard_name)
                        .on_submit(|s: &mut App, _| create_bot(s))
                        .build(&k),
                )
                .child(
                    rune_kit::Button::new("Create the bot")
                        .variant(rune_kit::ButtonVariant::Submit)
                        .expanded(true)
                        .on_press(|s: &mut App| create_bot(s))
                        .build(&k),
                ),
        )
}

fn create_bot(s: &mut App) {
    let name = s.onboard_name.text.trim().to_string();
    if name.is_empty() {
        return;
    }
    s.onboard_name = rune::TextEdit::new(String::new());
    s.net.mutate(
        crate::net::endpoints::Mutation::CreateProfile { name: name.clone(), description: None },
        &format!("create-profile:{name}"),
    );
}

/// Navigate helpers shared by rows across screens.
#[allow(dead_code)]
pub fn go(app: &mut App, route: Route) {
    app.route = route;
}
