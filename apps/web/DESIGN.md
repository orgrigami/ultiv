---
name: ultiv
description: The owner's night station for a crew of autonomous AI entities — an observatory control room, not a chat app.
colors:
  background: "oklch(0.166 0.012 275)"
  foreground: "oklch(0.928 0.014 85)"
  card: "oklch(0.2 0.014 275)"
  popover: "oklch(0.222 0.015 275)"
  muted: "oklch(0.228 0.012 275)"
  muted-foreground: "oklch(0.685 0.02 85)"
  secondary: "oklch(0.248 0.014 275)"
  accent: "oklch(0.27 0.017 275)"
  primary: "oklch(0.878 0.05 85)"
  primary-foreground: "oklch(0.21 0.03 85)"
  destructive: "oklch(0.65 0.2 25)"
  live: "oklch(0.8 0.125 75)"
  signal: "oklch(0.71 0.185 33)"
  ok: "oklch(0.75 0.11 160)"
  ring: "oklch(0.8 0.1 75)"
  border: "oklch(1 0 0 / 8.5%)"
  input: "oklch(1 0 0 / 13%)"
  sidebar: "oklch(0.146 0.011 275)"
  sidebar-accent: "oklch(0.24 0.014 275)"
  spec-o: "oklch(0.82 0.05 250)"
  spec-b: "oklch(0.76 0.09 255)"
  spec-a: "oklch(0.9 0.02 260)"
  spec-f: "oklch(0.88 0.045 95)"
  spec-g: "oklch(0.82 0.1 85)"
  spec-k: "oklch(0.76 0.13 60)"
  spec-m: "oklch(0.68 0.15 30)"
typography:
  display:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.55
  overline:
    fontFamily: "Geist Mono Variable, ui-monospace, SFMono-Regular, monospace"
    fontSize: "0.625rem"
    fontWeight: 500
    letterSpacing: "0.14em"
  readout:
    fontFamily: "Geist Mono Variable, ui-monospace, SFMono-Regular, monospace"
    fontSize: "0.6875rem"
    fontWeight: 400
    letterSpacing: "0.02em"
rounded:
  sm: "0.3125rem"
  md: "0.4375rem"
  lg: "0.5rem"
  xl: "0.75rem"
  2xl: "1rem"
spacing:
  row: "0.375rem"
  field: "0.625rem"
  section: "1rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.lg}"
    height: "2rem"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    height: "2rem"
  button-ghost:
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    height: "2rem"
  nav-row:
    backgroundColor: "{colors.sidebar-accent}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    height: "2.25rem"
  user-message:
    backgroundColor: "{colors.muted}"
    rounded: "{rounded.xl}"
  error-note:
    backgroundColor: "oklch(0.71 0.185 33 / 5%)"
    textColor: "{colors.signal}"
    rounded: "{rounded.lg}"
  overline-plate:
    textColor: "{colors.muted-foreground}"
    typography: "{typography.overline}"
  page-title:
    typography: "{typography.display}"
    textColor: "{colors.foreground}"
---

# Design System: ultiv

## Overview

**Creative North Star: "The Observatory Control Room"**

ultiv is the owner's night station for a crew of autonomous entities. The visual world is an observatory control room: deep blue-black ground, warm-tinted ivory ink, hairline seams at one device pixel, and instruments set in a mono voice under quiet sans prose. Every bot is a catalogued object with a spectral class; every state is a drawn mark, never an emoji, never a glow. The category-default floating-pill chat shell survives only as furniture (the composer, the tab bar) — the identity is the console rail, the roster, the readouts.

The system is built for one person reading for hours in the dark: instrument-grade calm, high density, tabular numbers everywhere anything is counted, and exactly one red light reserved for what demands the owner. Chrome floats translucent over the transcript so the prose terrain stays continuous; tool activity rides above it as a numbered overlay layer, never mixed into the prose. Expansion always explains — shaped bodies, definition lists, receipts one click away — never dumps raw JSON at the owner when a lens knows the call.

**Key Characteristics:**

- Four lightness elevation tiers on one blue-black hue; depth by tier, not by shadow
- Two typographic voices: Geist Mono as the instrument (overlines, readouts, accounting), Geist Sans for prose
- Star-catalog spectral tints (O B A F G K M) as bot identity, hashed from id — identity, not decoration
- One disciplined signal light: red only for what demands the owner, amber only for live work, green only for what settled
- State read through a small vocabulary of drawn SVG marks, one consistent stroke
- Hairline borders, plate rules with a graduation tick, no glow anywhere

## Colors

A warm-ink-on-cold-ground system: blue-black tiers carry the space, a single warm ivory does the pointing, and three state lights (amber / red / green) are the only saturated voices on a screen. Values below are the dark station — the default theme. The light theme is the same system inverted to warm paper (`--background oklch(0.972 0.004 90)`, `--foreground oklch(0.235 0.018 275)`, `--primary` becomes ink `oklch(0.32 0.02 275)`, state lights deepen: `--live oklch(0.62 0.13 70)`, `--signal oklch(0.55 0.2 30)`, `--ok oklch(0.58 0.12 158)`, borders become 14% ink). Every value is oklch so tiers and tints keep their lightness discipline; never substitute hex or raw Tailwind colors for a semantic token.

### Primary

- **Warm Ivory Ink** — `--primary` (`oklch(0.878 0.05 85)` dark): the ink-forward accent. The Chat circle in the tab bar, primary buttons, selection tint (24% mix), the caret. In light theme it inverts to deep ink blue. Rarity is the point: it marks where the owner acts, not where the system is busy.

### Secondary (state lights)

- **Live Amber** — `--live` (`oklch(0.8 0.125 75)` dark): working states only. The working mark, breathing presence on the roster, the input caret, the focus ring's hue family. Never for errors, never for decoration.
- **Signal Red** — `--signal` (`oklch(0.71 0.185 33)` dark): what demands the owner. Attention marks on the crew roster, error notes and error states, the wordmark's "lost" link state. Also aliases `--destructive` work (destructive is its near sibling, `oklch(0.65 0.2 25)` dark).
- **Ok Green** — `--ok` (`oklch(0.75 0.11 160)` dark): something settled. The wordmark's "live" dot, an enabled skill's status, HTTP statuses under 400 in a request body.

### Tertiary (spectral identity)

- **Spectral Classes O–M** — `--spec` per class, dark / light: O `oklch(0.82 0.05 250)` / `oklch(0.55 0.09 255)`, B `oklch(0.76 0.09 255)` / `oklch(0.5 0.12 258)`, A `oklch(0.9 0.02 260)` / `oklch(0.45 0.02 260)`, F `oklch(0.88 0.045 95)` / `oklch(0.55 0.08 90)`, G `oklch(0.82 0.1 85)` / `oklch(0.58 0.11 80)`, K `oklch(0.76 0.13 60)` / `oklch(0.55 0.14 55)`, M `oklch(0.68 0.15 30)` / `oklch(0.5 0.16 28)`. A bot's id hashes to one class (`spectralClassOf`); avatars render initials on `--spec-soft` (a 16% color-mix) with the mark text at spec 62% mixed into foreground and a 30% inset ring.

### Neutral (the four tiers)

- **Rail Black** — `--sidebar` (`oklch(0.146 0.011 275)` dark): the console rail's foundation, the darkest tier.
- **Ground** — `--background` (`oklch(0.166 0.012 275)` dark): the transcript terrain.
- **Raised Card** — `--card` (`oklch(0.2 0.014 275)` dark): cards, user messages sit on `--muted` (`oklch(0.228 0.012 275)`) at 70%.
- **Popover / Hover** — `--popover` (`oklch(0.222 0.015 275)`), `--secondary` (`oklch(0.248 0.014 275)`), `--accent` (`oklch(0.27 0.017 275)`): overlays, pressed and hover states, the top tier.
- **Ivory Foreground** — `--foreground` (`oklch(0.928 0.014 85)` dark): warm-tinted ivory text; `--muted-foreground` (`oklch(0.685 0.02 85)`) is the working voice for captions, overlines and readouts.
- **Hairlines** — `--border` (`oklch(1 0 0 / 8.5%)` dark, 14% ink light), `--input` (13% / 16%): translucent ink at one pixel, never a solid gray.

### Named Rules

**The One Signal Rule.** Red is reserved for what demands the owner. Amber means working, green means settled, red means the owner is needed. A screen shows red only where an owner decision or a failure lives.

**The No Glow Rule.** Nothing glows. Presence and work are stated with drawn marks and opacity breathing, never box-shadow glows, text-shadows, or luminous halos.

**The Hairline Rule.** Every seam is a 1px translucent-ink hairline from the theme (`--border`), never a solid gray and never thicker than a device pixel.

## Typography

**Display/Body Font:** Geist Variable (sans), with system sans fallback
**Instrument Font:** Geist Mono Variable, with `ui-monospace, SFMono-Regular, monospace` fallback

**Character:** Two voices under one family pair. Geist Sans carries prose — transcripts, leads, labels — at a dense 13px base with 1.55 leading. Geist Mono is the instrument voice: overline plates, readouts, catalog marks, and every tabular number. The mono voice always speaks small (10–11px) and always means "the machine said or measured this."

### Hierarchy

- **Display** (600, 1.375rem / 22px, tracking-tight): page titles only, one per screen above the plate rule.
- **Title** (600, 0.9375rem / 15px, tracking-tight): the wordmark; 500-weight 14px for row and button labels.
- **Body** (400, 0.8125rem / 13px, line-height 1.55): the base voice. Transcript text never renders below 12px (`text-xs` is the floor); long bot prose reads at `text-sm` with ~65ch max width.
- **Overline** (mono, 500, 0.625rem / 10px, letter-spacing 0.14em, uppercase, muted): plate headers ("Crew", "Station keeper"), record-field keys. Use the `.overline-plate` class.
- **Readout** (mono, 0.6875rem / 11px, tabular-nums, letter-spacing 0.02em): tool indices, durations, timestamps, link state, hit counts. Use the `.readout` class; `.tnum` adds tabular figures alone.

### Named Rules

**The Instrument Voice Rule.** Anything counted, measured, or hashed renders in Geist Mono with tabular figures. Anything said in prose renders in Geist Sans. A number inside a sentence is prose; a number in a column, a duration, or an index is an instrument readout.

## Layout

The app fills the dynamic viewport; the page itself never scrolls — every screen scrolls inside its own container (`html, body { height: 100%; overflow: hidden }`). Desktop (sm+) is primary: a fixed 16rem console rail on the left (wordmark plate, crew roster, labeled system links, per-bot recents, owner block at the foundation), the center column free for the transcript. Non-chat pages scroll in a `max-w-3xl` column (24px gutters at sm+, 12px on phones, safe-area padding top and bottom). Phones swap the rail for a fixed bottom tab bar (4rem + safe-area: Crew, Routines, a raised 3rem Chat circle, Tools, More) and set `--chat-bottom` so the floating composer clears it.

Spacing rhythm is tight and token-led: rows breathe in 6px steps, fields pad 10px, sections separate at 16px. Row targets are 36px on pointer-fine devices and a minimum 44px (`pointer-coarse:min-h-11`) on touch.

## Elevation & Depth

Depth is tonal first: four lightness tiers on one blue-black hue — rail (0.146), ground (0.166), card (0.2), popover (0.222) with hover/accent at 0.27 — carry almost all of the z-axis. Shadows exist in exactly one place: floating chrome. `.chrome-float` (composer, tasks pill) pairs a 72% translucent ground with `backdrop-filter: blur(20px) saturate(1.15)` and one directional offset shadow (`0 12px 32px -16px oklch(0 0 0 / 0.55)` dark, softened to 30% ink in light) — depth with direction, never an ambient halo. Nothing else casts a shadow at rest; hover states change background tier, not elevation. The transcript sinks under the floating header band with `.scroll-under`, a 4.75rem mask fade, so content dissolves instead of being sliced mid-line.

### Named Rules

**The Offset Shadow Rule.** A shadow appears only on floating translucent chrome, points straight down, and is negative-spread tightened. Flat surfaces never gain shadows to look clickable.

**The Sinking Transcript Rule.** Content approaching floating chrome fades under it (mask gradient); it is never clipped by a hard edge.

## Shapes

Radius grows from one base: `--radius: 0.5rem` (8px), with the Tailwind scale derived from it — `sm` 5px, `md` 7px, `lg` 8px, `xl` 12px, `2xl` 16px. Rows, buttons, cards, inputs and code plates live at `lg`; expanded bodies and user messages round to `xl`; avatars, marks and the Chat circle are circles; small inline chips may clamp to 10–12px. Form language is rectilinear and thin: 1px hairline borders on everything contained, no double borders (a card inside a card keeps one seam), no pill-shaped containers except the floating composer itself. The signature drawn geometry is the plate rule — a hairline with one 1×5px graduation tick at its left end (`.plate-rule`) — which seals every plate header and section seam.

## Components

### Buttons
- **Shape:** rounded-lg (8px), heights 2rem default / 1.75rem sm / 1.5rem xs; icons square.
- **Primary:** warm ivory fill, dark ink text, hover at 80% opacity.
- **Ghost:** transparent, hover fills to `--muted`; the default for quiet chrome (copy buttons, icon triggers).
- **Outline:** hairline border on ground, hover fills to `--muted`; destructive variant is a 10–20% signal tint with signal text, never a solid red fill.
- **States:** active presses translate 1px down; disabled drops to 50% opacity with no hover; focus is the shared ring.

### Marks (state vocabulary)
- **Style:** 14px drawn SVG (`Mark`), one stroke, current-color; kinds pending (faint ring), working (open arc, spinning), done (filled dot), error (ring + slash), attention (filled dot + soft ping), disabled (ring + backslash at 50%).
- **Tone:** ink (quiet), live amber (working), signal red (demands owner), ok green (settled), muted.
- **Motion:** working marks spin; roster presence breathes (`.live-breathe`, 2.6s); attention pings (`ping-soft`, 2.4s, motion-safe only). All stop under reduced motion.

### Trace (the numbered overlay)
- **Style:** the transcript's tool layer. Each call is one line: state mark or family icon, zero-padded two-digit index in `.readout` at 50% muted, owner-worded title (past tense done, present tense while running with a shimmer), truncated detail, tabular duration when ≥ 3s.
- **States:** running lines shimmer their title; error lines and triggers take `--destructive`; hover raises text to foreground.
- **Expansion:** bodies indent under a left hairline (`border-l pl-4`); bodies are shaped (search hit lists with numbered readout rows, definition-list records, terminal and HTTP code plates, rendered page markdown); raw input/output JSON receipts stay one click away; bodies scroll inside a bounded box (`max-h-72/80`), never the whole transcript. Long runs (over 8 steps) fold their head behind a "Show N earlier steps" readout line, keeping the last 3.

### Cards / Containers
- **Corner Style:** rounded-lg (8px); expanded bodies rounded-xl.
- **Background:** tier tokens only — card, popover, muted at 70% for the owner's message card.
- **Border:** 1px hairline; error notes tint border/background/text to signal (25% / 5% / full).
- **Internal Padding:** 10–14px; cards stay border-only, no shadow.

### Inputs / Fields
- **Style:** hairline `--input` border on ground, rounded-lg; the composer floats in `.chrome-float` instead.
- **Focus:** `:focus-visible` outline 2px at 65% `--ring` mix, offset 2px; controls get a 3px ring at 50% ring; the caret is always `--live`.
- **Error:** `aria-invalid` borders/rings destructive; a failed load is an ErrorState strip (signal tint, mark, Retry button), never an empty list.
- **Phones:** form controls force 16px below 640px so iOS Safari never zooms.

### Navigation
- **Console rail (sm+):** 16rem, rail-black tier, right hairline. Crew rows: 28px spectral avatar, name, right-aligned state mark (signal attention, breathing amber working); active row fills `--sidebar-accent`. System links: icon + label at 36px height, `aria-current` fills accent. The wordmark plate reads link state as a mark + readout ("live" green / "linking" muted / "lost" red).
- **Tab bar (phones):** 65% translucent ground, blur, top hairline; raised 3rem primary Chat circle; current tab ivory, rest muted.
- **Page header:** display title, optional muted lead, sealed by a plate rule.

### Signature Surfaces
- **Bot avatar:** round initials plate in the bot's spectral tint (`--spec-soft` fill, 62%-mixed spec text, 30% inset spec ring). No images are stored; the class letter is legible identity.
- **Composer pill:** `.chrome-float` bar — round "+" (quick prompts), the message box, round send arrow that joins a Stop while the bot works; a "Redirect now" pill rides above it mid-turn.
- **Wordmark plate:** "ultiv" at 15px/600 tracking-tight beside the link-state mark and readout — the station's own status line.

## Do's and Don'ts

### Do:
- **Do** use semantic tokens (`bg-background`, `text-muted-foreground`, `text-signal`) — every color on screen routes through one; never a raw hex or Tailwind palette color.
- **Do** render all counts, durations, indices and timestamps with `.readout` or `.tnum` (tabular figures) in Geist Mono.
- **Do** state every state through the `Mark` vocabulary with its tone; keep marks at row scale (14px) and one stroke.
- **Do** keep transcript text ≥ 12px, form controls at 16px on phones, touch targets ≥ 44px, and focus rings on every interactive element.
- **Do** fold long prose (> 1200 chars or 24 lines) behind a mask fade with a readout-voiced "Show more" — the fold is a reading aid, never a wall.
- **Do** respect reduced motion: breathing, pinging, shimmering and the streaming caret all stop (`motion-safe` / `motion-reduce` guards).

### Don't:
- **Don't** glow. No box-shadow halos, no text-shadows, no luminous accents; the signal light is a color, not a lamp.
- **Don't** spend signal red on anything the owner isn't being asked to look at, and don't spend amber on anything that isn't running right now.
- **Don't** mix tool output into the prose terrain; tool activity stays in the numbered Trace overlay, and raw JSON never appears where a shaped lens exists.
- **Don't** cast shadows on flat surfaces or use solid-gray borders; depth is tier, seams are hairlines.
- **Don't** introduce emoji, glyph icons, or a second icon set — Lucide line icons and the drawn marks are the whole vocabulary.
- **Don't** invent a new elevation tier, radius step, or accent hue; extend the existing four tiers, the `--radius` scale, and the spectral set.
