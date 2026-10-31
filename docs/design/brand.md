# Brand

The brand lives in one module, `apps/web/src/lib/brand.ts`: the name, the
wordmark, the tagline, the description, the mark's geometry and the three
fixed colors the icons and the manifest need. Everything else reads from it.
The live UI colors are tokens in `apps/web/src/index.css`.

## Name

**Ultiv**, written as the lowercase wordmark **ultiv** beside the mark. We
looked for a clearly better name and didn't find one: the warm, short
candidates we liked were already taken by AI-agent or consumer brands, and
"Ultiv" has no close clash. The rebrand is the identity, not the name.

## Mark

A soft amber gumdrop with two eyes and a sprout on top (the "cultivate" in
Ultiv: you grow a crew of bots). It is drawn from one path set on a 64×64
grid (`MARK` in `brand.ts`) and used three ways:

| Use                       | Where                                                                      | How                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| In-app mark               | sidebar lockup, empty states                                               | `BrandMark` / `BrandLockup` in `components/brand-mark.tsx`, theme tokens `--brand-amber` and `--brand-ink` |
| Favicon and any-size icon | `public/icons/icon.svg`, `favicon-32.png`                                  | `markSvg()` on the ink plate with rounded corners                                                          |
| Install icons             | `icon-192.png`, `icon-512.png`, `maskable-512.png`, `apple-touch-icon.png` | `markSvg()`; the maskable and iOS versions are full-bleed with more padding                                |

Regenerate the icons after changing the mark:

```sh
cd apps/web
node --experimental-strip-types scripts/brand-icons.ts             # SVGs only
PLAYWRIGHT_FROM=<dir with playwright in node_modules> \
  node --experimental-strip-types scripts/brand-icons.ts           # SVGs and PNGs
```

`lib/brand.test.ts` fails if the shipped `icon.svg`, the manifest or
`index.html` drift from `brand.ts`.

## Colors

One accent: **amber** (`--accent-tone`; `#efba64` in the dark theme). It
marks focus, live work and the brand. Ink (`#0d0e14`) and paper (`#f5f4f0`)
are the two theme backgrounds. Bots get their own character colors
(`--char-1` … `--char-6`), soft hues at one lightness, which are only used
for their avatars and never for UI state. Red (`--signal`) stays reserved
for what needs you.

## Characters

Every bot has a small creature avatar made from its id: body shape, eyes,
mouth, a top detail and a color, all chosen deterministically, so a bot looks
the same on every screen and device. The characters blink when you hover or
focus them, look around while their bot is working and hop once when it
needs you. Nothing moves while idle, and nothing moves at all with reduced
motion.

## Voice

Ultiv talks like a calm, capable colleague who keeps you posted. Say what
happened and what you can do next, in plain words and short sentences: "Nova
finished the trip notes", "Atlas wants to run bash", "Couldn't reach the
server. Retrying…". Name the bot, not the system. Lead with the outcome,
then the detail. No hype, no exclamation marks, no "AI-powered", no
apologies beyond a plain "couldn't"; a little warmth is fine in empty states
("All clear", "Say hello"), never in errors. Buttons are verbs ("Approve",
"New chat", "Try again"); counts are numbers ("2 things need you"). Keep the
owner informed in three beats: a quick acknowledgement, progress while it
runs, and the result when it's done.
