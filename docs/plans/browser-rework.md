# Browser rework: one broker, one session per bot, a driving seat that works on phones

Planned with the owner on 10 Nov 2026, after "browser_session op close did
not close, and the Browsers panel still lists it". Each item below has its
status and where it lives. Detail of how it works: docs/FEATURES.md (the
browser entries), docs/SECURITY.md and docs/THREAT_MODEL.md (the
boundaries), docs/LIVE.md (the cast wire).

## Why

- `close` killed the shared chromium but listed sessions per conversation,
  so other conversations' rows (and Watch, which relaunched a browser)
  outlived it; nothing else ever removed a row.
- One chromium per VM on an open debug port: every bot in a home could
  attach to it (and its cookies), a second bot was locked out by the first
  one's private files, and a cross-user `close` reported success while the
  browser stayed.
- The takeover view could not take a phone keyboard, paste, touch, dialogs,
  popups or files, and had no full screen.

## Phase 1: the takeover view

| #   | Item                                                                                                            | Status                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | Phone keyboard (hidden field focused by a tap)                                                                  | done: `components/takeover-key-catcher.tsx`, `lib/cast-keys.ts`                             |
| 2   | Paste (keys, long-press, Paste button)                                                                          | done                                                                                        |
| 2b  | Copy out of the page (the selected text, to the clipboard)                                                      | done: `copy` act, `CopiedText` fallback                                                     |
| 3   | Touch: tap, double-tap, swipe-scroll, press-and-hold drag                                                       | done: `lib/cast-pointer.ts`, `lib/use-cast-input.ts`                                        |
| 4   | Hover                                                                                                           | done                                                                                        |
| 5   | Page dialogs shown and answered                                                                                 | done (answers never wait behind other page work; late viewers learn an open dialog)         |
| 6   | Popups followed                                                                                                 | done                                                                                        |
| 7   | File picker                                                                                                     | done                                                                                        |
| 8   | Full screen (page resized to the screen, restored; Esc button)                                                  | done                                                                                        |
| 9   | Countdown and Extend                                                                                            | done (2 h ceiling)                                                                          |
| 10  | Stream: newest-frame backpressure, frames sized to the view, screenshot only without a repaint, canvas painting | done                                                                                        |
| 10b | WebSocket for the cast (frames down, acts up)                                                                   | done: `apps/server/src/cast-socket.ts`, `lib/cast-channel.ts`; SSE + POST stay the fallback |
| 11  | Typed/pasted text never logged                                                                                  | checked and documented (docs/SECURITY.md)                                                   |

## Phase 2: the broker

| #   | Item                                                                                                                | Status                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 12  | Broker, browser user and start-up in the VM (image + self-install), version check, owner-worded "rebuild the image" | done: `browser/vm/*.py`, `broker-install.ts`, `sandbox/Dockerfile` |
| 13  | One chromium per VM over a pipe, single start under a lock                                                          | done (pipe ends mapped from fds ≥ 10: the random start-up failure) |
| 14  | Only root reaches the broker; the server names the bot                                                              | done (stronger than checking the caller's uid)                     |
| 15  | One context per bot, one main tab + popups, one holder, per-home cap                                                | done (cap 4, `--max-sessions`)                                     |
| 16  | Ends: close, task end, 10 idle minutes (takeover keeps awake), owner Close; broker backstop                         | done                                                               |
| 17  | Panel rows per bot; Watch never relaunches                                                                          | done                                                               |
| 18  | A dead browser: a clear refusal for the bot, a Needs you row                                                        | done                                                               |
| 19  | Homes without per-bot users refused                                                                                 | done                                                               |
| 20  | Retire the old chromium; removed bots cleaned up; honest close message                                              | done                                                               |
| 21  | `browser_open` stays separate                                                                                       | decided and documented                                             |
| 2b  | Downloads into the bot's files, gated uploads from its files, chooser interception, caps, cleanup                   | done                                                               |

## Phase 3: sign-ins

| #   | Item                                                                    | Status                     |
| --- | ----------------------------------------------------------------------- | -------------------------- |
| 22  | Saved sign-ins per bot, sealed, restored                                | done: `browser/signins.ts` |
| 23  | Forget (per bot), gone with the bot                                     | done                       |
| 24  | User agent kept with the sign-in                                        | done                       |
| 25  | Vault login adapter (`browser_login`, TOTP, host check, first-use card) | done                       |
| 26  | Three layers: saved sign-in, vault fill, takeover                       | done                       |
| 27  | Sign a bot in yourself                                                  | done: "Sign in for <bot>"  |

## Phase 4: the bot's side and oversight

| #   | Item                                               | Status |
| --- | -------------------------------------------------- | ------ |
| 28  | Click and type by snapshot refs                    | done   |
| 29  | Per-site approvals (`browser_session@site:<host>`) | done   |
| 30  | Audit and per-bot browsing history                 | done   |

## Across

| #   | Item                                                       | Status                                                                                                                   |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 31  | Security docs incl. the shared-browser `--no-sandbox` risk | done                                                                                                                     |
| 32  | Docs, owner words, in-app skill                            | done                                                                                                                     |
| 33  | Tests                                                      | done: unit + REAL chromium (`browser/broker.test.ts`); two-users-in-a-VM suite written (`shell/real-vm-browser.test.ts`) |
| 34  | Done criteria                                              | see below                                                                                                                |

## Verified on real microVMs (10 Nov 2026)

- **The real-VM suite passes** (`SPRIESSEN_REAL_VM=1 vp test --run
  packages/ext/src/shell/real-vm-browser.test.ts`): the broker runs as
  `spbrowser`, a bot's `bash` can reach neither its socket nor port 9222,
  the bot's home is untouched, two bot users' cookies stay apart, and the
  live cast streams through the root relay.
- **Memory is measured** (docs/CAPACITY.md): 512 MiB holds one browsing
  bot with headroom, 1 GiB four; the cap is now sized from the VM, and a
  timed-out call is a worded refusal.

## Still the owner's to check

- **A real phone.** The phone layout, the hidden-keyboard path, taps,
  dialogs and full screen were exercised end to end at 390 px in headless
  chromium (the real panel, routes, `/cast` socket and broker), not on an
  iPhone or Android keyboard.
- **The done criterion**: Sebastian signs in to Google once from a phone,
  the next day's routine reuses it with no takeover. (The other half —
  another bot cannot reach his session — is the real-VM suite above.)

## Deferred on purpose

- A separate browser VM per home (the answer if the shared browser's
  `--no-sandbox` risk outgrows its memory saving).
- Team-shared sign-ins; passkeys held by the bot.
