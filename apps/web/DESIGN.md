---
name: spreissen
description: The owner's dark workspace for a crew of autonomous AI entities.
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
  section-label:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 500
  readout:
    fontFamily: "Geist Mono Variable, ui-monospace, SFMono-Regular, monospace"
    fontSize: "0.6875rem"
    fontWeight: 400
    letterSpacing: "0.02em"
rounded:
  sm: "0.375rem"
  md: "0.5469rem"
  lg: "0.625rem"
  xl: "0.9375rem"
  2xl: "1.25rem"
  3xl: "1.5625rem"
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
  section-label:
    textColor: "{colors.muted-foreground}"
    typography: "{typography.section-label}"
  page-title:
    typography: "{typography.display}"
    textColor: "{colors.foreground}"
---

# Design System: spreissen

## Overview

**Creative North Star: "A quiet dark workspace for a crew of AI entities"**

spreissen is the owner's workspace for a crew of autonomous entities: deep blue-black ground, warm-tinted ivory ink, hairline seams at one device pixel, quiet sans prose. Bots are named entities, each with its own small character drawn from its id (a soft creature in one of six hues); every state is a drawn mark, never an emoji, never a glow. The category-default floating-pill chat shell survives only as furniture (the composer, the tab bar); the identity is the nav rail, the roster, the readouts.

The system is built for one person reading for hours in the dark: calm, high density, tabular numbers everywhere anything is counted, and exactly one red light reserved for what demands the owner. Chrome floats translucent over the transcript so prose stays continuous; tool activity rides above it as a numbered overlay layer, never mixed into the prose. Expansion always explains (shaped bodies, definition lists, receipts one click away) and never dumps raw JSON at the owner when a lens knows the call.

**Key Characteristics:**

- Four lightness elevation tiers on one blue-black hue; depth by tier, not by shadow
- Two typographic voices: Geist Mono for measured data (readouts, accounting), Geist Sans for prose and labels
- One deterministic character per bot: the same id always draws the same creature; still when idle, it looks around while the bot works and hops once when it needs you
- One disciplined signal light: red only for what demands the owner, amber only for live work, green only for what settled
- State read through a small vocabulary of drawn SVG marks, one consistent stroke
- Hairline borders, plain language everywhere, no glow anywhere

## Colors

A warm-ink-on-cold-ground system: blue-black tiers carry the space, a single warm ivory does the pointing, and three state lights (amber / red / green) are the only saturated voices on a screen. Values below are the dark theme, the default. The light theme is the same system inverted to warm paper (`--background oklch(0.972 0.004 90)`, `--foreground oklch(0.235 0.018 275)`, `--primary` becomes ink `oklch(0.32 0.02 275)`, state lights deepen: `--live oklch(0.62 0.13 70)`, `--signal oklch(0.55 0.2 30)`, `--ok oklch(0.58 0.12 158)`, borders become 14% ink). Every value is oklch so tiers and tints keep their lightness discipline; never substitute hex or raw Tailwind colors for a semantic token.

### Primary

- **Warm Ivory Ink** — `--primary` (`oklch(0.878 0.05 85)` dark): the ink-forward accent. The Chat circle in the tab bar, primary buttons, selection tint (24% mix), the caret. In light theme it inverts to deep ink blue. Rarity is the point: it marks where the owner acts, not where the system is busy.

### Secondary (state lights)

- **Live Amber** — `--live` (`oklch(0.8 0.125 75)` dark): working states only. The working mark, breathing presence on the roster, the input caret, the focus ring's hue family. Never for errors, never for decoration.
- **Signal Red** — `--signal` (`oklch(0.71 0.185 33)` dark): what demands the owner. Attention marks on the crew roster, error notes and error states, the wordmark's "disconnected" state. Also aliases `--destructive` work (destructive is a near neighbor, `oklch(0.65 0.2 25)` dark).
- **Ok Green** — `--ok` (`oklch(0.75 0.11 160)` dark): something settled. The wordmark's "live" dot, an enabled skill's status, HTTP statuses under 400 in a request body.

### Neutral (the four tiers)

- **Rail Black** — `--sidebar` (`oklch(0.146 0.011 275)` dark): the nav rail's foundation, the darkest tier.
- **Ground** — `--background` (`oklch(0.166 0.012 275)` dark): the transcript ground.
- **Raised Card** — `--card` (`oklch(0.2 0.014 275)` dark): cards, user messages sit on `--muted` (`oklch(0.228 0.012 275)`) at 70%.
- **Popover / Hover** — `--popover` (`oklch(0.222 0.015 275)`), `--secondary` (`oklch(0.248 0.014 275)`), `--accent` (`oklch(0.27 0.017 275)`): overlays, pressed and hover states, the top tier.
- **Ivory Foreground** — `--foreground` (`oklch(0.928 0.014 85)` dark): warm-tinted ivory text; `--muted-foreground` (`oklch(0.685 0.02 85)`) is the working color for captions, labels and readouts.
- **Hairlines** — `--border` (`oklch(1 0 0 / 8.5%)` dark, 14% ink light), `--input` (13% / 16%): translucent ink at one pixel, never a solid gray.

### Named Rules

**The One Signal Rule.** Red is reserved for what demands the owner. Amber means working, green means settled, red means the owner is needed. A screen shows red only where an owner decision or a failure lives.

**The No Glow Rule.** Nothing glows. Presence and work are stated with drawn marks and opacity breathing, never box-shadow glows, text-shadows, or luminous halos.

**The Hairline Rule.** Every seam is a 1px translucent-ink hairline from the theme (`--border`), never a solid gray and never thicker than a device pixel.

## Typography

**Display/Body Font:** Geist Variable (sans), with system sans fallback
**Mono Font:** Geist Mono Variable, with `ui-monospace, SFMono-Regular, monospace` fallback

**Character:** Two voices under one family pair. Geist Sans carries prose — transcripts, leads, labels — at a dense 13px base with 1.55 leading. Geist Mono is the data voice: readouts and every tabular number. The mono voice always speaks small (10–11px) and always means "the machine said or measured this."

### Hierarchy

- **Display** (600, 1.375rem / 22px, tracking-tight): page titles only, one per screen.
- **Title** (600, 0.9375rem / 15px, tracking-tight): the wordmark; 500-weight 14px for row and button labels.
- **Body** (400, 0.8125rem / 13px, line-height 1.55): the base voice. Transcript text never renders below 12px (`text-xs` is the floor); long bot prose reads at `text-sm` with ~65ch max width.
- **Section label** (sans, 500, 0.6875rem / 11px, muted): section and field headers ("Crew", "Model"). Use the `.section-label` class.
- **Readout** (mono, 0.6875rem / 11px, tabular-nums, letter-spacing 0.02em): tool indices, durations, timestamps, link state, hit counts. Use the `.readout` class; `.tnum` adds tabular figures alone.

### Named Rules

**The Mono Data Rule.** Anything counted or measured renders in Geist Mono with tabular figures. Anything said in prose renders in Geist Sans. A number inside a sentence is prose; a number in a column, a duration, or an index is a mono readout.

## Layout

The app fills the dynamic viewport; the page itself never scrolls — every screen scrolls inside its own container (`html, body { height: 100%; overflow: hidden }`). Desktop (sm+) is primary: a fixed 16rem nav rail on the left (wordmark row, New chat, Find, the five sections with the crew roster under Crew, a Recents list of chats, Settings at the bottom), the center column free for the transcript, and on `lg+` a floating work pane on the right for a task, a file, memory or Needs you. Non-chat pages scroll in a `max-w-3xl` column (24px gutters at sm+, 12px on phones, safe-area padding top and bottom). Phones swap the rail for a fixed bottom tab bar (4rem + safe-area: Chat, Past chats, Needs you, Crew, Settings) and set `--chat-bottom` so the floating composer clears it; the work pane becomes a full-height sheet.

Spacing rhythm is tight and token-led: rows breathe in 6px steps, fields pad 10px, sections separate at 16px. Row targets are 36px on pointer-fine devices and a minimum 44px (`pointer-coarse:min-h-11`) on touch.

## Elevation & Depth

Depth is tonal first: four lightness tiers on one blue-black hue — rail (0.146), ground (0.166), card (0.2), popover (0.222) with hover/accent at 0.27 — carry almost all of the z-axis. Shadows exist in exactly one place: floating chrome. `.chrome-float` (composer, tasks pill) pairs a 72% translucent ground with `backdrop-filter: blur(20px) saturate(1.15)` and one directional offset shadow (`0 12px 32px -16px oklch(0 0 0 / 0.55)` dark, softened to 30% ink in light) — depth with direction, never an ambient halo. Nothing else casts a shadow at rest; hover states change background tier, not elevation. The transcript sinks under the floating header band with `.scroll-under`, a 4.75rem mask fade, so content dissolves instead of being sliced mid-line.

### Named Rules

**The Offset Shadow Rule.** A shadow appears only on floating translucent chrome, points straight down, and is negative-spread tightened. Flat surfaces never gain shadows to look clickable.

**The Sinking Transcript Rule.** Content approaching floating chrome fades under it (mask gradient); it is never clipped by a hard edge.

## Shapes

Radius grows from one base: `--radius: 0.625rem` (10px), with the Tailwind scale derived from it — `sm` 6px, `md` 9px, `lg` 10px, `xl` 15px, `2xl` 20px, `3xl` 25px. Buttons, inputs and code blocks live at `lg`; cards, list groups and rows at `2xl`; sheets, the work pane, the quick switcher and empty states at `3xl`; avatars, marks, tab pills, the header pill and the composer are round. Surfaces are soft, borders stay thin: 1px hairlines on everything contained, no double borders (a card inside a card keeps one seam). Section seams are plain hairlines (`border-t`).

## Components

### Buttons

- **Shape:** rounded-lg (10px), heights 2rem default / 1.75rem sm / 1.5rem xs; icons square.
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
- **Expansion:** bodies indent under a left hairline (`border-l pl-4`); bodies are shaped (search hit lists with numbered readout rows, definition-list records, terminal and HTTP code blocks, rendered page markdown); unshaped calls read as input rows plus a typed output block (pretty JSON, or the output's own bullet/key-value shape as titled rows); bodies scroll inside a bounded box (`max-h-72/80`), never the whole transcript. Long runs (over 8 steps) fold their head behind a "Show N earlier steps" readout line, keeping the last 3.

### Cards / Containers

- **Corner Style:** rounded-lg (10px); expanded bodies rounded-xl (15px).
- **Background:** tier tokens only — card, popover, muted at 70% for the owner's message card.
- **Border:** 1px hairline; error notes tint border/background/text to signal (25% / 5% / full).
- **Internal Padding:** 10–14px; cards stay border-only, no shadow.

### Inputs / Fields

- **Style:** hairline `--input` border on ground, rounded-lg; the composer floats in `.chrome-float` instead.
- **Focus:** `:focus-visible` outline 2px at 65% `--ring` mix, offset 2px; controls get a 3px ring at 50% ring; the caret is always `--live`.
- **Error:** `aria-invalid` borders/rings destructive; a failed load is an ErrorState strip (signal tint, mark, Retry button), never an empty list.
- **Phones:** form controls force 16px below 640px so iOS Safari never zooms.

### Navigation

- **Nav rail (sm+):** 16rem, rail-black tier, right hairline. Crew rows: the bot's character, name, right-aligned state mark (signal attention, breathing amber working); active row fills `--sidebar-accent`. System links: icon + label at 36px height, `aria-current` fills accent. The wordmark row reads connection state as a mark + readout ("connected" green / "connecting" muted / "disconnected" red).
- **Tab bar (phones):** 65% translucent ground, blur, top hairline; five equal tabs, the Needs you count on its bell; current tab ivory, rest muted.
- **Page header:** display title, optional muted lead, closed by a hairline.

### Signature Surfaces

- **Bot character:** a creature on a plate tinted with its own hue (`lib/avatar.ts` picks body, eyes, mouth, top and hue from the id's hash; `components/bot-avatar.tsx` draws it). No images are stored. Sizes from 24px (rows, bubbles' header) to the 96–112px profile hero. Idle costs nothing: it moves only on hover, while its bot works (`mood="thinking"`) or once when it needs you (`mood="alert"`), and never under reduced motion.
- **Profile hero:** the character big and centered, name, role, then round Open chat / Edit; under it pill tabs with live counts and, on Overview, file-style cards (tinted icon tile, title, one line, chevron).
- **Work pane:** a 3xl floating panel beside the chat on `lg+` (a sheet below), with Back through up to four opened things and Close; Escape closes it.
- **Quick switcher:** Cmd/Ctrl-K opens a 3xl panel near the top: one field, results grouped Actions · Go to · Bots · Past chats, arrow keys and Enter. N starts a new chat, ? shows the shortcut sheet.
- **Composer pill:** `.chrome-float` bar — round "+" (quick prompts), the message box, round send arrow that joins a Stop while the bot works; a "Redirect now" pill rides above it mid-turn.
- **Wordmark row:** "spreissen" at 15px/600 tracking-tight beside the connection mark and readout, the app's own status line.

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
- **Don't** mix tool output into the prose; tool activity stays in the numbered Trace overlay, and raw JSON never appears where a shaped lens exists.
- **Don't** cast shadows on flat surfaces or use solid-gray borders; depth is tier, seams are hairlines.
- **Don't** introduce emoji, glyph icons, or a second icon set — Lucide line icons and the drawn marks are the whole vocabulary.
- **Don't** invent a new elevation tier, radius step, or accent hue; extend the existing four tiers and the `--radius` scale.
