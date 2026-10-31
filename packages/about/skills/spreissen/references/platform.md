# The contracts underneath

The things this skill's other references only name. Distilled from the
app's own engineering docs. When code and this file disagree, the code
wins, and the drift is worth mentioning to your owner.

## Quick answers

| Question                                    | Answer                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| Did a routine fire?                         | Look up its write-ahead receipt (Routines). Never guess.                               |
| Why was my message to a sibling refused?    | Per-exchange cap, hourly per-pair rate, deadline, or lineage cap. The tool says which. |
| Where did a fact come from?                 | Facts are stamped: your turn, your owner, or data.                                     |
| Why did a credential ask for approval?      | A credential's first use on a host always asks.                                        |
| Can memory change without my owner knowing? | No. The weekly tidy only proposes.                                                     |

## Memory, the contract

Memory is five tiers in durable stores: core (the small always-loaded set),
facts, the graph of entities, episodes, and archive.

- Facts carry a kind, an importance, a trust class and a validity window.
  Nothing is deleted except by your owner's Purge.
- Writes consolidate: a new fact that duplicates or updates an old one
  supersedes it in one transaction instead of piling up.
- The write guard stamps where every fact came from (your turn, your owner,
  data) and refuses secrets and instructions that arrived as data.
- Core memory is tiny and budgeted: your owner's standing facts (shared by
  every bot) plus your own profile core, keeper-gated for owners.
- Nothing changes memory behind your owner's back: a weekly tidy only
  PROPOSES, and your owner accepts or rejects each proposal.

## Routines, the contract

Three kinds of wake: schedules (cron, in your owner's time zone), inbound
webhooks (schema-validated ingress; a rejected payload is receipted), and
sensors (calendar feeds, per-sensor RSS, watched pages, deduped by
fingerprint).

- Every fire leaves a WRITE-AHEAD RECEIPT, so "did it actually fire?" is a
  lookup. Repeated failures disable the job and escalate.
- Deliveries debounce per session and retry, then dead-letter with an
  escalation to your owner.
- Routine turns are STEERED into your busy turns rather than queued behind
  them; sensors queue as follow-ups.
- Bracketed inputs tell you the source: `[cron ...]`, `[webhook ...]`,
  `[sensor ...]`.

## Messaging and tasks, the contract

Bot-to-bot messaging runs in CONTEXTUAL ROOMS: each participant keeps its
own seat conversation, so identity, memory and artifact scope stay
per-entity even mid-conversation. A room is a tunnel: a message lands on the
recipient's main thread, and thinking happens there, in the open.

Sends are asynchronous and budgeted:

- A per-exchange cap limits how many messages you may send a sibling,
  counting since your owner's last real instruction on your thread. A fresh
  brief resets it.
- A per-pair rate caps the hour.
- Deadlines turn an unanswered request into a NACK.
- Lineage caps stop request-passing chains.

Wakes carry a signal, never a transcript copy; the room tool reads the full
history when you need it.

Tasks are background sub-agent turns in their own durable conversations,
run AS the bot that spawned them (its tools, memory and audit name).

- They cap at a few running per bot.
- Parents end their turns and are woken with the result. A parent can steer
  a running task mid-flight, and a task can post rare progress lines to the
  owner.
- Restarts never reap work: a task still running at boot resumes.

## Approvals, vault and the broker, the contract

Destructive, costly or outward-reaching tools are GATED: the call parks, a
card goes to your owner's web app and phone with your one-sentence reason,
and the answer returns to the call.

- Your owner's auto-approve list and approval mode can pre-clear tools
  ("always allow"). Floors never auto-approve: credentials, connectors, and
  the host shell.
- The vault seals your owner's secrets: per-item encryption, masked
  metadata, and no tool ever returns secret bytes.
- The credential broker spends a secret only inside its binding: approved
  hosts, methods and placements; https only; auth dropped on cross-host
  redirects. The audit records the call's shape, never the secret.
- A credential's FIRST use on a host always asks, whatever the allowlist
  says.
- If an app needs a key mid-task, the secure-input flow puts the entry in
  front of your owner. Keys never travel as tool arguments or through chat.

## The record, and how it is built

Two ledgers back the whole story: the transcripts (every conversation,
durable and searchable) and the audit trail (every tool call, approval,
mailbox event and escalation, stamped with the acting profile). Push
notifications are minimal by design: event kind and bot name, never your
message text.

Under the hood, for orientation: Spreissen is an effect-first pnpm monorepo.

- The kernel (`@spreissen/core`) holds shared errors and the runtime door.
- The extension platform (`@spreissen/ext`) holds tools, connectors, plugins,
  the registry and the credential vault.
- The entity substrate (`@spreissen/mind`) is one runtime hosting every profile.
- TypeBox contracts are shared by the server (a thin chord host with REST)
  and the web client (React).
- Storage is durable by default.

This section is orientation, not an invitation to quote architecture at your
owner. Use it when they ask how the place is put together.
