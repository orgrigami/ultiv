# UX roadmap — patterns from the Grok Bot / Dots / Muse review

Source: external review (2026-10-26) comparing Cursor's Grok Bot, OpenAI's Dots
and Meta's Muse against our web app. Effort: S small, M medium, L large.

## Wave 1 — DONE (security-adjacent smalls)

| #   | Pattern                                        | Where                                                                                                                                                                                                                                                      |
| --- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7   | Specific errors that keep your draft           | `lib/api.ts` — every REST failure now throws `ApiError` carrying the server's `{ error }` body; `DELETE` fails loudly instead of returning `false` (a 409 on the main/last bot used to read as success)                                                    |
| 5   | Warning labels on risky cards                  | `session-view.tsx` — approval cards for outside-reaching tools get a red border + "may not be reversible" warning                                                                                                                                          |
| 6   | Hide as the safe option; confirm before delete | `bots-panel.tsx` — hide/unhide via the archive routes, hidden bots sort under a "Hidden" label and leave the profile picker; bot delete, session delete and vault-item remove all go through `ConfirmDialog`; profile purge requires typing the bot's name |
| 8   | Vault never shows a value after saving         | `ext/vault.ts` — key masks reveal zero characters (the 2-char prefix leak is gone); vault panel shows `last used` metadata, fields clear after save                                                                                                        |

## Wave 2 — next (M)

- **3 — Approval cards on the server** (M): DONE for the chat surface —
  Allow once / Always allow / Deny; "Always allow" appends the tool — or, on
  an already-patterned profile, the call's exact action text as a narrow
  `tool:pattern` — to the bot's `policies.autoApprove` (contract v14,
  `approve {always}` returns the stored entries; a multi-field or destructive
  call stores nothing and the card says so); pending
  cards already survive reload (server-mirrored `pendingFor` cell); Stop now
  releases pending cards (each waiter denied) instead of leaving them active.
  Remaining: expiry tuning for background asks, and `always` support in the
  REST approval inbox.
- **2 — Sidebar badge** (S): DONE — bots with a pending approval show a
  destructive "needs you" badge (polls the owner-scoped
  `GET /api/approvals` inbox every 5 s; Hide landed in wave 1).
- **Push instead of poll** (M): still polling (3 s tasks, 5 s badge, 250 ms
  approvals in the session projection). Needs a push path (REST has none —
  chord replicated-object attach desyncs, so SSE/long-poll on REST is the
  option). The Stop affordance exists in the composer and tasks panel.

## Wave 3 — then (M/L)

- **1 — One chat per profile as the home screen** (M): DONE for the core —
  home IS the active bot's main chat (main bot by default, switcher on top,
  chat swaps in place on switch); Bots/Rooms/Vault/History live behind header
  dialogs; a shared `Chat` component serves both home and
  /sessions/$id; deep links intact; empty state spawns the first bot.
  Remaining: profile tabs (Activity/Scheduled/Memory/Files) once the views
  exist — the memory panel is ready to move in.
- **9 — Activity view per task** (M): DONE — every task row opens an activity
  dialog: progress (the task conversation's projected tail via the new
  `GET /api/tasks/:id/activity`), the result/error when settled, files made
  (artifacts by conversation), and any approval waiting on the task with
  Approve/Deny inline. Polls at 2.5 s while open.
- **9b — Task approvals pop into the spawning thread** (S): DONE — a gate
  waiting on a background task renders as an approval card in the chat that
  spawned it (labelled `Bot · task "…" wants to …`), next to the chat's own
  card; no more digging through the task sheet. `GET /api/tasks` rows carry
  `taskConversationId` + `waitingApproval` for running tasks; decide routes
  REST to the task's own conversation (`api.approvalDecide`), always/takeover
  included, and the tasks poll (3 s) refreshes the card away. The activity
  dialog keeps the full tri-state for when the card has already scrolled up.
- **Pattern 3 leftover — inbox `always`**: DONE — `POST /api/approvals/:conv/:call`
  takes `always` and saves the same rule via the shared
  `mind.profiles.allowTool(owner, profileId, tool, input)` (the chord session's
  always-allow now uses it too); the task activity dialog's waiting card has
  the full tri-state. Pattern 3 is now complete on every surface. Entries are
  bounded and shape-checked on PATCH (the hook compiles globs synchronously),
  and a patterned profile only ever gains narrow exact-text patterns — never
  the whole tool, never `bash_host`. Patterns themselves are authored via raw
  REST only (the bot dialog's field removes entries but cannot author a
  pattern yet — follow-up wave).
- **4 — Three outcomes for actions** (M): DONE (thin handback) — every
  approval surface (chat card, task activity dialog, REST inbox) offers
  **Take over** alongside Deny / Always allow / Approve. Take over denies the
  call with a broker-carried note — "the owner is handling this themselves —
  do not retry" — so the agent adapts instead of nagging (Session contract
  v9 `takeover`; `mind.approvals.decide(note)` + `noteFor`, read-once; audit
  records "taken over by the owner"). A full pause-and-handback protocol
  (agent suspends the turn until the owner confirms) remains a possible
  upgrade on the same seam.
- **11 — First-run onboarding** (M): DONE — the empty workspace shows three
  template cards (Assistant / Researcher / Projects, each with a capability
  checklist) that spawn a bot with a full identity in one click; the home
  then opens straight into its seeded intro chat. Custom identity stays
  below the templates. Suggestion chips under an empty chat: deferred — the
  server seeds an intro turn, so chats are rarely empty.
- **10 — Memory view per profile** (M): DONE as a per-bot panel — "What X
  remembers" on every bot row: list / add / per-item forget (new
  `mind.memory.remove` + `DELETE /api/profiles/:id/memory/:recordId`) and an
  artifacts shelf with downloads. The review's "(unknown)" attachments turned
  out to be the prompt-side fallback for missing artifact ids in
  `session.ts` `withAttachments`, not a UI label — nothing to fix there.
  Remaining: fold the panel into profile tabs when pattern 1 lands.
- **12 — Phone-first layout** (L): core DONE — phones get a bottom tab bar
  (Chat / Bots / Vault / History) with real views instead of dialogs; the chat
  only hides when you leave its tab (the chord link stays mounted); form
  controls are 16px on small screens so iOS doesn't zoom on focus. Desktop is
  unchanged. Remaining: per-bot notification switch (no notification system
  exists yet to switch), and a 44px tap-target audit of the remaining icon
  buttons.

Basics to fold in continuously (8): dark mode, Cmd-K palette, streaming with
stable keys, a11y labels, empty/loading states.

**Desktop full width** (Harry's add, 2026-10-26): the home is a three-column
desktop layout — persistent Bots sidebar (lg+), capped chat center, History
rail (xl+); header Bots/History dialog buttons appear only in the middle
breakpoints; mobile keeps the bottom tab bar. Verified at 1440 / 800 / 390.

**Memory panel tabs** (2026-10-28): "What X remembers" is now five tabs —
Facts (search, current/history toggle, edit via tombstone+re-add, Forgotten
list with restore), People & things (entity cards with alias chips; merge
stays disabled until the entity-merge detector ships), Core (Shared/This-bot
split with correct store ids, word meters, inline edit via the PATCH route;
reorder/pin-toggle noted as no-API), Tidy (open badge, run feedback, proposal
cards with affected facts, reject warning, edit & accept for merge/stale,
purge confirm listing the lost facts + count echo), and Files. Loading and
error states with retry; initial focus lands on the dialog title. DONE:
everything above. Remaining: entity merge UI once the API exists, core
reorder/pin-toggle routes if wanted, and folding the panel into profile tabs
(pattern 1 leftover).

**Approval mode controls** (2026-10-28): `policies.approvalMode` (manual |
jev | yolo) is live on both surfaces — the Edit-bot dialog gains an
"Approval mode" select (Manual — ask me / Jev decides / Fully automatic,
with a one-line hint), and the chat header details popover gains an
"Approvals" select that PATCHes just the mode key and refreshes app state.
Yolo never covers credential/connector first use; jev routes through the
Decide faculty and hands the owner anything Jev won't answer.
