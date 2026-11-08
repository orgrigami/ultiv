//! The sign-in gate: the same words the web's gate shows, with the passcode
//! path only (passkeys stay a browser ceremony; the server keeps the passcode
//! as the permanent fallback).

use crate::net::endpoints::Mutation;
use crate::state::{App, Gate};
use crate::ui::common;
use rune::tok::space;
use rune::{col, el, text, El};
use rune_kit::{Button, ButtonVariant, TextInput};

pub fn view(s: &App, dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    let Gate::SignIn { error, first, .. } = &s.gate else { return col() };
    let first = *first;
    let (title, words, button) = if first {
        ("Set a passcode", "The first one, from this machine, becomes it. Everyone signs in with it after.", "Set it")
    } else {
        ("Sign in", "with your passcode", "Sign in")
    };
    let mut card = el()
        .key("gate-card")
        .w(360.0)
        .padding(space::S6)
        .gap(16.0)
        .radius(20.0)
        .fill(t.card)
        .border(1.0, t.hairline)
        .shadow(8.0, 24.0, t.fg.alpha(if dark { 0.3 } else { 0.12 }))
        .child(brand_wordmark(dark))
        .child(text(title.to_string()).font(common::ty::TITLE).color(t.fg))
        .child(text(words.to_string()).font(common::ty::UI).color(t.muted_fg))
        .child(
            TextInput::new(&gate_passcode(s))
                .placeholder("Passcode")
                .secure()
                .on_edit(|s: &mut App| match &mut s.gate {
                    Gate::SignIn { passcode, .. } => passcode,
                    _ => &mut s.scratch_edit,
                })
                .on_submit(move |s: &mut App, _| submit(s, first))
                .build(&crate::theme::kit(dark)),
        )
        .child(
            Button::new(button)
                .variant(ButtonVariant::Submit)
                .expanded(true)
                .on_press(move |s: &mut App| submit(s, first))
                .build(&crate::theme::kit(dark)),
        );
    if let Some(e) = error {
        card = card.child(
            el()
                .key("gate-error")
                .w_full()
                .padding(space::S2)
                .radius(9.0)
                .fill(t.signal.alpha(0.12))
                .child(text(e.clone()).font(common::ty::META).color(t.signal)),
        );
    }
    card = card.child(text(format!("Server: {}", s.server)).font(common::ty::MONO).color(t.muted_fg));
    col().key("gate").w_full().h_full().center().fill(t.background).child(card)
}

fn gate_passcode(s: &App) -> &rune::TextEdit {
    match &s.gate {
        Gate::SignIn { passcode, .. } => passcode,
        _ => &s.scratch_edit,
    }
}

fn submit(s: &mut App, first: bool) {
    let Gate::SignIn { passcode, .. } = &s.gate else { return };
    let code = passcode.text.clone();
    if code.trim().is_empty() {
        return;
    }
    let mutation = if first { Mutation::SetPasscode(code) } else { Mutation::SignIn(code) };
    s.net.mutate(mutation, "sign-in");
}

/// The wordmark: the amber brand mark + the name (the one brand module).
pub fn brand_wordmark(dark: bool) -> El {
    let t = crate::theme::tokens(dark);
    el()
        .key("wordmark")
        .gap(space::S2)
        .center_y()
        .child(
            el()
                .key("mark")
                .size(18.0, 18.0)
                .radius(6.0)
                .fill(t.brand_amber)
                .child(el().key("dot").size(6.0, 6.0).absolute(6.0, 6.0).radius(3.0).fill(t.brand_ink)),
        )
        .child(text("Spriessen".to_string()).font(common::ty::UI_MED).color(t.fg))
}
