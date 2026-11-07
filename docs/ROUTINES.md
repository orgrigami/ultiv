# Routines — the durability and delivery contract

A **Routine** is anything that wakes an entity on its own: cron schedules,
inbound webhooks, and (planned) sensors. This document is the contract every
Routine shares. It exists because the worst failure in this space is one that
_looks like success_ — a trigger that never fired, a payload silently
dropped, a rotated key indistinguishable from a quiet day.

## What is durable

| Thing                                           | Durable?                                  | Where                                 |
| ----------------------------------------------- | ----------------------------------------- | ------------------------------------- |
| Cron registry (`ultiv.cronjobs`)                | yes                                       | mind doc, re-armed on boot            |
| Webhook registry (`ultiv.webhooks`)             | yes                                       | mind doc, v3 (schemas + counters)     |
| Sensor registry + dedup rings (`ultiv.sensors`) | yes                                       | mind doc                              |
| **Profile KV state** (`ultiv.kv.<profile>`)     | yes                                       | mind doc family                       |
| **Fire receipts** (`ultiv.routine-events`)      | yes                                       | mind doc, newest first, capped at 400 |
| Mailbox envelopes, dead-letters                 | yes                                       | mind docs                             |
| Rate-limit token buckets                        | **no** (in-memory, restart resets)        | server process                        |
| Debounce windows                                | **no** (payloads already receipted first) | server process                        |

The `ultiv.` record names predate the rename to Spriessen and are kept on
purpose: they name data already on disk.

## Attention: escalations must ARRIVE

Every escalation (cron disabled, webhook dead-letter, mailbox dead-letter)
rides the audit faculty's escalation hook. The server wires it to a pager
(`apps/server/src/attention.ts`): email through Resend when
`RESEND_API_KEY` + `EMAIL_FROM` + `ESCALATION_EMAIL` are set, coalesced to
one notification per kind+subject per hour, and always a loud console line.
Unconfigured pager ≠ silent system — the audit tail and receipt log remain
the source of truth.

Agents may rely on the registry and the receipt log. They may NOT treat
"no state" as "never acted" — a wiped store and a first run are
indistinguishable from inside; the receipt log exists so they never have to
guess.

## Quiet check-ins: no news costs no attention

A routine run reaches the owner as a push (a webhook, cron or sensor turn
that settles with a reply; a background routine task that finishes). Most
runs find nothing new, so a bot ends such a run with exactly
`[nothing to report]` (`NOTHING_TO_REPORT`, `@spriessen/contracts`
`quiet.ts`; `isNothingToReport` tolerates case, backticks and a full stop).
The server sends no push for it (`deliver.ts` reply listeners,
`push/events.ts` `taskEarnsPush`), and both clients draw it as one quiet
line, "Checked in: nothing to report", instead of a reply or a result card.
The rule lives in the bot's identity rules (`act/identity.ts`) and in every
background routine task's brief (`tasks/background.ts` `QUIET_ROUTINE`).
The run still leaves its fire receipt: quiet is not silent.

## Fire receipts (write-ahead)

Every fire writes a receipt BEFORE delivery is attempted, then settles it:

- `accepted` — durably recorded, delivery pending. **A receipt stuck here is
  a crash signature** (a visible incomplete pair), never silence.
- `delivered` — admitted into the session conversation (admission is the
  contract; a failed TURN afterwards is the transcript's problem).
- `failed` — delivery exhausted its retries (webhooks) or admission failed
  (cron, 3 consecutive → job disabled + audit escalation).
- `rejected` — ingress refused the call; `reason` is the class.
- `trial` — a schedule's fire ran as a trial (every action held back).
- `ignored` — a webhook payload from a sender off its allow list, with no
  thread chat to add context to; nothing was woken.

Lookup: `GET /api/routines/events?routine=<id>&source=cron|webhook|test&limit=N`.
Schedules expose `fireCount` / `lastFiredAt`; webhooks expose counters plus
`rejectsLast24h` via the receipt log. "Did it actually fire?" is a lookup.
The Routines screen re-reads these when it opens, when the window regains
focus, and right after a webhook's **Send test** or **New token** (no polling
loop; a one-time token URL or test payload being read stays on screen).

## Webhooks — one-way, ack-then-process

The ingress answers the sender ONCE, fast, and honestly:

1. unknown id → `404`; wrong token → `401` (counted per webhook — a climbing
   `rejectedLast24h` with flat accepts is key rotation). Only the token's
   SHA-256 hash is stored and compared in constant time; the token is shown
   once (at creation or **New token**) — see `docs/SECURITY.md`.
2. body over 64 KB → `413`. The route reads at most one byte past the cap
   and closes the connection, so an oversized upload is never buffered.
3. rate limit (30/min default, `WEBHOOK_RATE_PER_MIN`) → `429` +
   `retryAfterS`.
4. schema check (pre-ack): invalid JSON or schema mismatch → `422` with
   detail; the body is retained (last 5, truncated) for the webhook's AUTHOR
   — the entity — to diagnose its own schema drift.
   Rejects (steps 1–4) are recorded at most 10 per webhook per minute:
   a caller without the token cannot fill the reject list or push real
   receipts out of the shared routine log. Past that the caller still gets
   its answer; only the record is skipped.
5. everything passed → receipt written (write-ahead), counters bumped,
   payload queued, ack `200 {ok, eventId}`. The `eventId` is the
   correlation handle for "what happened to my event".

### Threads and who may ask (`packages/mind/src/webhooks/route.ts`, `threads.ts`)

A webhook can give each outside thread (a GitHub issue, a Slack thread, a
support ticket) its OWN chat: `threadKey` is the dotted path to the thread
id in the payload (`issue.number`, `event.thread_ts`; `pathValue` reads
strings, numbers and array indexes). The first payload of a thread opens a
chat under the webhook's bot, titled from `threadTitle` (else
"<webhook name> · <id>"); later payloads continue it, so the thread's history
stays together and out of the main chat. The thread→chat map lives on the
webhook (`threads`, the least recently active forgotten past
`MAX_WEBHOOK_THREADS` 200); resolution is one at a time per webhook, so two
payloads of a new thread open ONE chat; a chat the owner removed is replaced
by a new one. A payload without a thread id goes to the webhook's own chat.

`senders` (`{ path, allow }`) says who may start work: only an allowed
sender (compared without case) opens a thread chat or wakes the bot. Anyone
else's payload lands in a thread that already has a chat as a CONTEXT-ONLY
note (`ultiv.webhook-context`; its text says "context only: this sender may
not ask you for work"; no turn, no push) and is receipted `ignored`
otherwise. A stranger who can reach the URL (a public repo's comments) can
never open a chat or wake the bot. This is dsh-superagent's gate (allowed
lists; follow-ups reach the thread's work without new authority) shaped as
a webhook setting. Set by `webhook_create` (`thread_key`, `thread_title`,
`allow_senders`) or `POST /api/webhooks`; the Routines row shows the thread
count and an "Allowed senders only" badge.

After the ack the sender walks away and never retries, so post-ack failure
is the pump's problem: 3 attempts (1s, 4s backoff), then `failed` receipts +
an audit escalation (`webhook-dead-letter`). Deliveries to one session
coalesce within `WEBHOOK_DEBOUNCE_MS` (default 2.5s) — a burst arrives as
one wake carrying every payload, each with its own receipt.

- **Bearer tokens never reach the entity.** Tools and tool outputs carry the
  id/path and the accounting; the owner reads the token in the app.
  Senders SHOULD use the `x-spriessen-token` header (the old `x-ultiv-token`
  is still accepted) over the `?token=` query
  form — query strings end up in access logs. Test-fire
  (`POST /api/webhooks/:id/test`, owner) validates a probe payload against
  the schema without delivering — rejected probes are receipted.
- **Per-record `whenBusy`** (cron + webhooks, default steer) picks each
  routine's mid-turn policy: `steer` joins the turn at the next boundary,
  `followUp` waits, `reject` refuses while busy. Sensors are always
  follow-ups.
- **Mailbox wakes coalesce** (`MAILBOX_WAKE_DEBOUNCE_MS`, default 8s): a
  burst of envelopes to one conversation rides one wake, joined by a
  separator — follow-up policy, like sensors.

## Cron

- **Trials** (`packages/mind/src/routines/trial.ts`, `mind.trials`): a
  schedule's prompt run AS its bot, on the model and with the exact input
  the live fire would use (`trialInputOf`), in a fresh conversation
  (`trial:<job>:<run>`, adopted as kind "task": background lane, in no chat)
  held by the evals dry-run guard, so every tool call is blocked before it
  runs: nothing is written, sent, spent or put up for approval, no chat is
  woken, no push goes out. The reply and each call it tried (input kept
  JSON-safe, ≤1500 chars) land on the job as `trials` (newest last, at most
  `TRIALS_KEPT` 3). A schedule in **trial mode** (`trial: true`, recurring
  only: a one-shot's single fire is the real one) runs every fire this way
  and receipts it `trial`; `schedule_set` takes `trial`, the owner's Routines
  row has Try now (`POST /api/cron/:id/try`, 202, one at a time per job),
  Go live and Pause/Resume (`PATCH /api/cron/:id { trial?, enabled? }`); a
  landed trial fires the `routines` live signal. Start a routine that acts
  on the world as a trial, and let it act once its trials look right.
- Schedules render in the **profile's timezone**; new profiles default to
  **Asia/Jakarta (WIB)**.
- Creation (`schedule_set` tool, `POST /api/cron`) returns the **next 3 fire
  times** so the author verifies intent before the schedule commits.
- One-shots (`once`, epoch ms) self-retire on success; on 3 consecutive
  failures they are **disabled in place** (visibly dead, not vanished) with
  an audit escalation.
- Delivery rides the same admission path as typed input. **Routine wakes STEER a turn in flight** (`whenBusy: "steer"` — admitted at the next tool boundary), so the old "wakes never land mid-turn" constraint is gone. Sensors deliberately queue as follow-ups instead: a low-priority tick must not derail active work. Bursts still coalesce via the webhook debounce; that is a documented behavior, not a bug — check the receipts.

## Sensors

A sensor watches an external source and wakes the entity on events. Tools:
`sensor_set` / `sensor_list` / `sensor_remove` (set/remove gated).

- **calendar** — the owner's ICS feed (`CALENDAR_ICS_URL`), polled by the
  server's sensor loop (`SENSOR_POLL_MS`, default 5 min); wakes
  `leadMinutes` before matching event starts (1h grace for missed polls).
- **rss** — the sensor's OWN feed URL (http/https, validated at creation);
  wakes on every unseen item whose title matches, capped at 5 per poll.
  Parser: `parseFeed` in `@spriessen/ext` (RSS 2.0 + Atom, minimal).
- **watch** — any URL, EDGE-TRIGGERED: the first poll records a baseline
  fingerprint (sha256 of the body, never fires); each later poll fires once
  iff the fingerprint changed. `match` filters on raw body text (no match
  text present = unchanged). This is the threshold/state-crossing shape.

- **Dedup is the source's natural key** (ICS UID, RSS guid / Atom id),
  stored in a ring on the sensor row — each real-world event wakes the
  entity exactly once, across restarts. Missing uid falls back to
  `summary@start` / `title@pubAt` (`rssUidOf`, used by both the seen-check
  and the record). Watch sensors dedup by transition instead
  (`lastState` fingerprint), which is the point of the kind.
- Fires are write-ahead receipts (`source: "sensor"`), delivered as
  **follow-ups** (never steering).
- Feed errors land on the sensor's `lastError` — visible in
  `GET /api/sensors` and `sensor_list`. A source larger than 5 MB
  (`SENSOR_MAX_BYTES`) is an error too; it is never buffered whole.
- A pass that outlasts `SENSOR_POLL_MS` is not doubled: the next tick is
  skipped while one runs.

## Cron missed-tick policy

**Recurring jobs do not catch up.** A fire requires the process alive at
fire time; a tick missed during downtime is skipped (the receipt log shows
the gap). One-shots are the opposite: a `once` that passed while down fires
immediately on boot (retrying a delivery that never succeeded). This is
deliberate — "daily at 9" after an outage should resume tomorrow at 9, not
fire a burst of stale prompts at boot.

## Durable state (the KV plane)

`state_get` / `state_set` / `state_delete` / `state_list` — a profile-scoped
key-value store over a durable doc family (`ultiv.kv.<profile>`), live
across sessions, wakes and restarts. This is where dedup ledgers, generation
tokens and "already acted" markers belong. The semantic rule survives: unset
is NOT proof of never-acted — write generation markers for anything whose
absence must be distinguishable. Values cap at 8KB (store pointers, not
payloads).
