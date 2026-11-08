# The desktop client

`apps/desktop` is the native desktop client: a Rust app built on
[Rune](https://github.com/anomalyco/rune) (git dep, pinned to a `dev` rev —
`dev` is never rewritten), talking to the same server surfaces the web client
uses: REST for everything, `/push` for the coarse live signals, and the chord
protocol for the live chat transcript. No Effect, no Node in the UI process.

It targets **1-on-1 feature parity with `apps/web`** — the same routes, the
same data, the same words — except the mobile mode (the phone tab bar, the
bottom sheets, the safe-area chrome), which a desktop window doesn't have.

## The gate: `DESKTOP_APP_ACTIVE`

The default install never touches Rust. Setting `DESKTOP_APP_ACTIVE=1` adds a
desktop build step to `scripts/install-cli.sh` (`scripts/build-desktop.sh`:
`cargo build --release`, then the binary lands in `~/.spriessen/bin/` and the
chord sidecar in `~/.spriessen/sidecar/`). `cargo` missing fails that step
with a sentence, never the install.

- `SPRIESSEN_URL` points the app at its server (default `http://127.0.0.1:8787`).
- Sign-in is the passcode path only (passkeys stay a browser ceremony). The
  session cookie is kept at `~/.spriessen/desktop-session` (0600); `spriessen
  update --force` rebuilds everything without skipping up-to-date steps, the
  desktop leg included when the gate is on.
- `SPRIESSEN_COOKIE` overrides the saved session — headless checks and tests
  use it.

## Architecture

| Piece                                  | What it is                                                                                                                                                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/theme.rs`                         | the web's tokens, ported 1:1 from `apps/web/src/index.css` (OKLCH ramp, type scale 12/14/16/20, radii 6-15 + 20/25 literals, `--signal`/`--live`/`--deny`/characters), into a rune-kit `Kit` plus a `Tokens` set                                                                      |
| `src/net/`                             | one REST worker thread (`api.rs` transport, `endpoints.rs` the endpoint table) + the `/push` socket thread (`push.rs`, reconnect with backoff, 70 s silence watchdog, close 4401 = Expired)                                                                                           |
| `src/bridge.rs` + `sidecar/bridge.mjs` | the live chat: a Node sidecar running the **web's own chord client** (`@earendil-works/chord` + the Session contract), relaying Session state and actions (input/approve/interrupt/configure/withdraw/retryQueued) to the app over JSON lines. The Rust side never reimplements chord |
| `src/state.rs`, `src/update.rs`        | one `App` state (routes, caches, drafts, dock, switcher) and the event map: which `/push` signal refetches what (docs/LIVE.md's table)                                                                                                                                                |
| `src/ui/`                              | the rail (wordmark, New chat, Find, four sections, crew roster, Recents), the gate, and one module per screen: now, crew, profile (pill tabs), settings, routines, history (word search), rooms, tools (connectors/skills/vault), chat, dock, switcher                                |
| `src/ui/common.rs`                     | the shared idioms: Page header, card-of-rows, empty states, skeletons, relative time, and the bot characters (the FNV-1a `characterOf` port)                                                                                                                                          |

## Checking work

```
cd apps/desktop
cargo test                                   # unit tests
cargo run -- --snap /tmp/app.png             # headless snapshot (the gate)
cargo run -- --scene now --snap /tmp/now.png # a named screen
```

Full flow against a hermetic stack (from the repo root):

```
vp node apps/desktop/e2e/boot.ts             # scratch server, passcode devdesktop, two bots
SPRIESSEN_URL=… SPRIESSEN_COOKIE=… cargo run -- --frames 900 --scene now --snap /tmp/now.png
```

Scenes: `now`, `crew`, `settings`, `routines`, `history`, `rooms`, `tools`,
`light`. Snapshots need `--frames N` so the fetches land (the app arms a 30 ms
`wake_after` to keep polling while replies are in flight).

## Parity status

Working: sign-in gate (bootstrap and sign-in), rail with roster and Recents,
Chats with the live chord transcript, send via the composer, the tool-call
lens rows (the web's owner words through `@spriessen/present` in the
sidecar), the reaction chips and the Branch button on the owner's messages,
all four approval cards (decision with Always allow, secret fields to the
vault, the question card with one-tap options, and the bot-create form with
its override), Stop while the bot works, Needs you with approve/deny and
parked retry, Now (working/finished/goals/files), Crew and bot profiles with
pill tabs including the Persona/Instructions editors, the memory v2 panel,
the eval cases, and the browser-takeover ask list, Settings (server check,
default model, task default, pause, nodes pairing with the one-time token,
theme, sign out), Routines (enable/trial, webhook test), Past chats with the
words said, Bot talks with the owner composer, Tools tabs with the skills
overview (per-bot namespaces, detail with the enable switch, proposal
verdicts) and vault, org teams (create, pages with rename, the bots whose
home they are), the work dock (max five tabs, task timelines, file previews:
images decode through the rune cache, CSV/TSV draw tables, text renders
mono), and the quick switcher (Cmd/Ctrl-K, N).

Behind the web: the lens's expanded per-kind bodies (shaped search/HTTP/
terminal views — rows carry titles and details only), file previews' toolbar
(source/wrap/copy/download/fullscreen), org grants and templates, eval RUNS
(the cases list reads here), the takeover live cast (SSE; the desktop lists
asks), reactions the owner sets (the web only shows the bot's), and
per-field editors on the deeper settings forms. Web Push is replaced by the
OS; `docs/WEB.md` remains the behavior authority for everything both clients
share.
