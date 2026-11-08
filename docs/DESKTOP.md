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

**1-on-1 with `apps/web`, mobile mode excepted.** Working, end to end: the
sign-in gate (bootstrap and sign-in), the rail (wordmark, New chat, Find,
the four sections, the crew roster, Recents), Chats with the live chord
transcript (send, queue, Stop, streaming caret), the full tool-call lens —
owner-worded rows that expand into the shaped per-kind bodies (search hits,
HTTP round trips, terminal, files, records, pages, raw output, plain lines,
quoted bodies with tags) and error notes — the reaction chips and Branch on
the owner's messages, all four approval cards (decision with Always allow,
secret fields to the vault, the question card with one-tap options, and the
bot-create form with its override), Needs you (approve/deny, parked retry,
dismissals), Now (working/finished/goals/files), Crew and bot profiles with
all eleven pill tabs: overview (make main, hide, unhide), Persona and
Instructions editors with Save, the memory v2 panel, eval cases with Run
all and the run history per check, tables, the takeover ask list driving
the LIVE cast in the dock (frames over SSE, tap/type/nav/reload, Finish and
Step away), Routines, Access, Files, Activity, Tests, Settings (server
check, default model, task default, pause, nodes pairing with the one-time
token, theme, sign out), Routines (enable/trial, webhook test), Past chats
with the words said, Bot talks with the owner composer, Tools (connectors,
skills with detail + enable + proposal verdicts, vault), org teams (create,
rename, the bots whose home they are, published templates with Copy here /
Unpublish, the org's grants with revoke), the work dock (max five tabs,
task timelines, file previews: images through the rune cache, CSV/TSV
tables, markdown rendered or as source, wrap, copy, download to
`~/Downloads/spriessen/`, fullscreen), and the quick switcher (Cmd/Ctrl-K,
N, Esc).

Deliberately different, none of it mobile: the phone tab bar, bottom
sheets, safe-area chrome and Web Push (the OS owns notifications) do not
exist on a desktop window; `docs/WEB.md` remains the behavior authority for
everything both clients share.
