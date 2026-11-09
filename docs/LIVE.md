# Live updates (the push socket)

How the client learns about changes without polling.

## Design in one paragraph

A plain WebSocket at `/push`, cookie-authenticated by the same gate as every
other surface, carries COARSE change signals: small JSON frames like
`{"kind":"tasks","at":…}` that say a slice changed, never what changed. The
client refetches that slice over the REST it already uses (the web
dev/preview proxy carries `/push` beside `/chord`, see `apps/web/dev-proxy.ts`), which stays the
only source of truth. Nothing on this socket is a replicated chord object
(chord 1.4.0's attach desync, see AGENTS.md, is exactly why); it is a dumb
broadcast with an authenticated handshake and a backoff reconnect. When the
session behind it ends, the server closes it with code 4401 and the client
brings the sign-in gate back (docs/SECURITY.md).

## Signals and where they come from

| Signal                                                          | Source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tasks`, `needs-you`                                            | `mind.tasks.listen` (a task settled), `mind.tasks.onUpdate` (any row change), the running-task conversation watcher (`apps/server/src/live-tasks.ts`, the same in-process view the chat Session holds)                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `approvals`, `needs-you`                                        | `mind.approvals.listen`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `connectors`                                                    | `mind.mcp.subscribe` (connection state, tools, OAuth)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `mailbox`                                                       | `mind.mailbox.listen` (every committed envelope write: send, delivery, reply, NACK, expiry), coalesced to one frame per 250 ms — bot-to-bot traffic never passes REST                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| everything else                                                 | the REST dispatcher maps each mutating route to its slices (`liveKindsFor`), so a PATCH of a bot signals `profiles`+`sessions`; `takeovers` comes from the takeover registry's own `listen` (an ask opened, or closed any way: finish, step-away, its cap, a replacement, a stopped turn — with `needs-you`) and the active-browsers registry (a session appearing, moving page or closing; coalesced 250 ms), NOT from the tool's audit record: the takeover call BLOCKS, so its record lands only when the ask closes — the Browsers panel refetches, so a bot's ask appears the moment it happens (the cast's own traffic, frames and acts, signals nothing) |
| `memory`, `skills`, `routines`, `profiles`+`sessions` from bots | `mind.audit.listen`: each successful tool call a bot makes is mapped by name (`liveKindsForTool`: memory writes, skill saves, schedule/sensor/webhook changes, bot and team admin) — reads map to nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

`sync` is client-side only: on (re)connect every open screen refetches once,
so a phone waking from sleep catches up without a poll.

## The one payload stream: the browser cast

Everything above is a signal. The live browser takeover is the one
deliberate exception: `GET /api/browser/takeover/:id/cast` (and its
watch-only twin `GET /api/browser/sessions/:conversationId/cast`) is a server-sent
event stream whose `frame` events CARRY the payload — JPEG screencast frames
of the bot's browser, `ready`/`cast-error`/`closed` for the channel itself.
It is not CRUD and rides no chord object: one in-VM driver process pushes
frames, SSE subscribers fan out from it, slow consumers drop stale frames
(the newest one is always next), and a 15 s comment line keeps proxies from
buffering. Acts are ordinary POSTs to `/:id/cast/act` (the client sends
them one at a time, in order) — the stream stays one-way; the watch stream
has no act route at all. Scope is the same as every takeover route: the conversation's
owner. See docs/FEATURES.md ("Owner takeover of a browser session, LIVE").

## What replaced the 5 s polls

`app-state.tsx` (approvals and tasks), `use-tasks.ts` (the chat's task chip and live task lines),
`use-sessions.ts` (bots and chats), the routines, vault, skills and memory
panels (through `lib/use-live-refresh.ts`, which collapses a burst into one
refetch),
`use-task-activity.ts` (the task sheet), `connectors-panel.tsx` and the Bot
talks views (`lib/use-live-load.ts` under `room-timeline.tsx` and
`rooms-panel.tsx`) all subscribe through `lib/live.ts` now. Window-focus refetches stay everywhere,
because a sleeping tab misses frames and a locked phone misses all of them.
Still on `setInterval`, on purpose:

- `lib/push.ts` — the Web Push presence heartbeat (per-tab visibility for the
  notifier; not a data poll).
- `lib/use-now.ts` — the UI clock (`useNow`) for relative times.
- `lib/live.ts` — the socket watchdog (see below; it reads no data).

## Heartbeat and watchdog

A phone that sleeps or changes networks leaves sockets half-open: no close
ever arrives, so nothing reconnects and the screen quietly stops updating.
Every 25 s the server pings each open socket (chord links and `/push`) and
terminates one that did not answer the previous ping
(`apps/server/src/heartbeat.ts`); `/push` also carries a
`{"kind":"heartbeat"}` frame, because browsers answer pings without showing
them to the page. The client's watchdog (`lib/live.ts`) reconnects when the
socket has been silent for 70 s (checked every 15 s, when the page becomes
visible again, and on `online`), and drops the chord link with it
(`dropLink` in `lib/chord.ts`) so open chats reopen too. The heartbeat
frame is never dispatched to screens.

## Testing

`apps/server/src/live.test.ts` connects with a session, triggers a REST
mutation, and asserts the frame arrives within a second (and that an
anonymous socket is refused); `heartbeat.test.ts` drops a client that stops
answering pings. `apps/web/src/lib/live.test.ts` greps the four
former poll sites for `setInterval` so a poll cannot quietly come back.
