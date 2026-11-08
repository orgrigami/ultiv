//! The Spriessen theme, ported 1:1 from `apps/web/src/index.css` (the live source).
//! Dark is the reference theme; light mirrors it. Values are OKLCH so the ramp
//! keeps its lightness steps, exactly as the web tokens do.

use rune::tok::Theme;
use rune::{Color, TextStyle, oklch, oklcha};
use rune_kit::{Kit, PaletteFocus, PaletteSeed, Radius, StateColors, Type};

/// The web's type scale: meta 12/16, ui 14/20 (body default), chat 16/24,
/// title 20/28. Mono only for code, paths, hosts and tool names.
pub fn type_scale() -> Type {
    let ui = TextStyle::new(14.0, 400.0).lh(20.0);
    let ui_med = TextStyle::new(14.0, 500.0).lh(20.0);
    let meta = TextStyle::new(12.0, 400.0).lh(16.0);
    let meta_med = TextStyle::new(12.0, 500.0).lh(16.0);
    Type {
        ui,
        ui_medium: ui_med,
        ui_compact: TextStyle::new(14.0, 400.0).lh(20.0),
        small: meta,
        small_medium: meta_med,
        body: ui,
        body_medium: ui_med,
        text_small: meta,
        text_small_medium: meta_med,
        text_xsmall: meta,
        text_xsmall_medium: meta_med,
        mono: TextStyle::new(13.0, 400.0).lh(16.0).mono(),
    }
}

/// Radii from the web: sm 6, md 9, lg 10 (fields, buttons), xl 15 (cards,
/// list containers). The 20/25 tiers (2xl, 3xl) are literals at their sites.
pub fn radii() -> Radius {
    Radius { xs: 4.0, sm: 6.0, md: 9.0, lg: 10.0, xl: 15.0 }
}

/// The web's text styles, off the kit scale where the web is deliberate.
pub mod ty {
    use rune::TextStyle;
    /// `text-meta` 12/16: timestamps, labels, readouts.
    pub const META: TextStyle = TextStyle::new(12.0, 400.0).lh(16.0);
    /// `.section-label`: meta at 500.
    pub const META_MED: TextStyle = TextStyle::new(12.0, 500.0).lh(16.0);
    /// `text-ui` 14/20: rows, cards, buttons (the body default).
    pub const UI: TextStyle = TextStyle::new(14.0, 400.0).lh(20.0);
    pub const UI_MED: TextStyle = TextStyle::new(14.0, 500.0).lh(20.0);
    /// `text-chat` 16/24: messages and the composer.
    pub const CHAT: TextStyle = TextStyle::new(16.0, 400.0).lh(24.0);
    /// `text-title` 20/28: screen titles.
    pub const TITLE: TextStyle = TextStyle::new(20.0, 500.0).lh(28.0);
    /// Readouts and code: mono, tabular figures.
    pub const MONO: TextStyle = TextStyle::new(13.0, 400.0).lh(16.0).mono();
    pub const MONO_MED: TextStyle = TextStyle::new(13.0, 500.0).lh(16.0).mono();
}

/// Semantic colors a state role paints with (the `--signal`, `--deny`, … set).
pub struct Tokens {
    /// `--signal`: the one red light for what needs the owner.
    pub signal: Color,
    pub signal_fg: Color,
    /// `--warning` (YOLO, care).
    pub warning: Color,
    /// `--live`: amber, working.
    pub live: Color,
    /// `--deny`: destructive.
    pub deny: Color,
    /// `--success`: settled.
    pub success: Color,
    /// Bot character hues (`--char-1…6`) and their ink.
    pub char: [Color; 6],
    pub char_ink: Color,
    /// The brand mark keeps its colors in both themes.
    pub brand_amber: Color,
    pub brand_ink: Color,
    /// `--muted`: the owner's message card ground.
    pub muted: Color,
    /// `--primary` and its ink: where the owner acts.
    pub primary: Color,
    pub primary_fg: Color,
    /// `--ring`.
    pub ring: Color,
    /// `--hairline` (`--border`).
    pub hairline: Color,
    /// `--gray-11` (`--muted-foreground`).
    pub muted_fg: Color,
    /// `--gray-12` (`--foreground`).
    pub fg: Color,
    /// `--background` (`--gray-2`).
    pub background: Color,
    /// `--card` (`--gray-3`).
    pub card: Color,
    /// `--popover` (`--gray-4`).
    pub popover: Color,
    /// `--sidebar` (`--gray-1`).
    pub sidebar: Color,
}

impl Tokens {
    /// A translucent ink wash over the ground (hover tracks, fills).
    pub fn wash(&self, a: f32) -> Color {
        self.fg.alpha(a)
    }

    /// The rail's selected-row wash (`--sidebar-accent`).
    pub fn sidebar_wash(&self, dark: bool) -> Color {
        if dark {
            oklch(0.24, 0.014, 275.0)
        } else {
            oklch(0.92, 0.008, 90.0)
        }
    }
}


fn state(c: Color, dark: bool) -> StateColors {
    let (_, ch, h) = oklch_parts(c);
    let surface_l = if dark { 0.2 } else { 0.95 };
    StateColors {
        bg: oklcha(surface_l, ch * 0.3, h, 1.0),
        fg: c,
        border: oklch(if dark { 0.4 } else { 0.85 }, ch * 0.5, h),
        icon: c,
    }
}

/// Recover the (l, c, h) parts the token was authored with. Rune stores colors
/// as Oklab, so go through it: hue from a/b, chroma from their length.
fn oklch_parts(c: Color) -> (f32, f32, f32) {
    let [l, a, b, _] = c.to_oklab();
    (l, a.hypot(b), b.atan2(a).to_degrees().rem_euclid(360.0))
}

/// The token set for one appearance. `dark` is the reference theme.
pub fn tokens(dark: bool) -> Tokens {
    Tokens {
        signal: oklch(if dark { 0.72 } else { 0.55 }, 0.18, 33.0),
        signal_fg: oklch(if dark { 0.18 } else { 0.99 }, 0.03, 30.0),
        warning: oklch(if dark { 0.78 } else { 0.52 }, 0.14, 52.0),
        live: oklch(if dark { 0.82 } else { 0.53 }, 0.12, if dark { 78.0 } else { 70.0 }),
        deny: oklch(if dark { 0.68 } else { 0.53 }, 0.2, if dark { 25.0 } else { 27.0 }),
        success: oklch(if dark { 0.76 } else { 0.5 }, 0.12, 155.0),
        char: [
            oklch(0.8, 0.12, 78.0),
            oklch(0.76, 0.13, 30.0),
            oklch(0.8, 0.11, 160.0),
            oklch(0.77, 0.1, 235.0),
            oklch(0.75, 0.12, 295.0),
            oklch(0.78, 0.12, 350.0),
        ],
        char_ink: if dark { oklch(0.166, 0.012, 275.0) } else { oklch(0.2, 0.015, 275.0) },
        brand_amber: oklch(0.82, 0.12, 78.0),
        brand_ink: oklch(0.166, 0.012, 275.0),
        muted: oklch(if dark { 0.228 } else { 0.945 }, 0.012, if dark { 275.0 } else { 90.0 }),
        primary: if dark { oklch(0.88, 0.045, 85.0) } else { oklch(0.32, 0.02, 275.0) },
        primary_fg: if dark { oklch(0.21, 0.03, 85.0) } else { oklch(0.972, 0.004, 90.0) },
        ring: oklch(if dark { 0.8 } else { 0.62 }, 0.1, if dark { 75.0 } else { 70.0 }),
        hairline: if dark { oklcha(1.0, 0.0, 0.0, 0.085) } else { oklcha(0.235, 0.018, 275.0, 0.14) },
        muted_fg: if dark { oklch(0.7, 0.02, 85.0) } else { oklch(0.47, 0.016, 275.0) },
        fg: if dark { oklch(0.93, 0.014, 85.0) } else { oklch(0.235, 0.018, 275.0) },
        background: if dark { oklch(0.166, 0.012, 275.0) } else { oklch(0.972, 0.004, 90.0) },
        card: if dark { oklch(0.2, 0.014, 275.0) } else { oklch(0.995, 0.002, 90.0) },
        popover: if dark { oklch(0.222, 0.015, 275.0) } else { oklch(0.995, 0.002, 90.0) },
        sidebar: if dark { oklch(0.146, 0.011, 275.0) } else { oklch(0.948, 0.005, 90.0) },
    }
}

/// The kit built from the web's three anchors (background, foreground, accent
/// tone), then the exact web values patched in where the web is deliberate.
pub fn kit(dark: bool) -> Kit {
    let (bg_l, bg_c, bg_h) = if dark { (0.166, 0.012, 275.0) } else { (0.972, 0.004, 90.0) };
    let fg_l = if dark { 0.93 } else { 0.235 };
    let fg_c = if dark { 0.014 } else { 0.018 };
    let t = tokens(dark);
    let seed = PaletteSeed { bg: oklch(bg_l, bg_c, bg_h), fg: oklch(fg_l, fg_c, if dark { 85.0 } else { 275.0 }), accent: t.live };
    let mut k = Kit::from_palette_focus(seed, PaletteFocus::Custom(t.ring));
    k.dark = dark;
    k.ty = type_scale();
    k.radius = radii();
    // State roles keep the web's exact token values.
    k.c.success = state(t.success, dark);
    k.c.warning = state(t.warning, dark);
    k.c.danger = state(t.deny, dark);
    k.c.info = state(oklch(if dark { 0.76 } else { 0.55 }, 0.09, 255.0), dark);
    k.c.bg_accent = t.live;
    k.c.text_accent = t.live;
    k.c.icon_accent = t.live;
    k.invalid_text = true;
    k
}

/// The kit plus the core `Theme` for hand-drawn surfaces (the chrome the kit
/// doesn't cover), as the settings example pairs them.
pub fn painted(dark: bool) -> (Kit, Theme, Tokens) {
    (kit(dark), rune::tok::theme(dark), tokens(dark))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_follow_the_appearance() {
        let dark = tokens(true);
        let light = tokens(false);
        assert!(dark.signal != light.signal, "the red light shifts with the theme");
        assert_eq!(dark.brand_amber, light.brand_amber, "the brand keeps its colors");
    }

    #[test]
    fn kit_carries_the_web_type_scale() {
        let k = kit(true);
        assert_eq!(k.ty.ui.size, 14.0);
        assert_eq!(k.ty.ui.line_height, 20.0);
        assert_eq!(k.ty.small.size, 12.0);
        assert_eq!(k.radius.lg, 10.0);
        assert_eq!(k.radius.xl, 15.0);
    }
}
