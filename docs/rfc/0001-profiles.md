# RFC 0001 — Profiles: user-defined entities, vault, and the inter-entity mailbox

Status: **implemented** (2026-10-26, commits 69c512d..). v1–v3 shipped in full plus the v4 seams:
the memory hierarchy with write authority, external-sender trust classes in the mailbox, and
export/import bundles. Not yet built: the outbound federation HTTP shim (§10 transport — the
envelope schema and trust rules are live via `deliverExternal`), the notification push channel
(the approval inbox + dead-letter REST surfaces + audit escalations are the attention path), and
profile management UI beyond the switcher/Bot Mode pin. Transcript export is not in the bundle
(the harness has no conversation export API); sessions import as fresh chats.
Scope: `@ultiv/mind`, `@ultiv/ext`, `packages/contracts`, `apps/server`, `apps/web`.

## 1. Summary

Ultiv grows a layer above sessions: **profiles**. A profile is a user-defined AI entity —
its own name, persona, persistent chat, sessions, artifacts, credentials scope, and (later)
memories. Entities communicate with each other through an asynchronous, durable **mailbox**
carried on per-pair **DM threads**, and act on external services through a **vault** that
brokers credentials without ever exposing them to the model.

Two stance decisions, made by the owner during the brainstorm:

- **One entity per profile.** Not "one entity wearing personas." Each profile names itself,
  remembers for itself, and speaks first-person about its own faculties. The current
  AGENTS.md line ("the platform's ONE AI entity") is revised when this ships: _one runtime,
  one entity per profile_. `packages/mind` stays the shared substrate.
- **Profiles are fully user-defined.** No shipped template library. Persona text, tool
  allowlist, and policies are the user's own configuration. The examples in this RFC
  (Chief of Staff, Researcher, Note Taker) are illustrations, not presets.

## 2. Product shape

A profile owns:

| Surface                | Content                                                                        |
| ---------------------- | ------------------------------------------------------------------------------ |
| Main chat ("Bot Mode") | one persistent session, created with the profile, never deleted (only reset)   |
| Sessions               | create/remove as today, scoped to the profile                                  |
| DM threads             | one durable conversation per entity pair (§5), where bot-to-bot happens        |
| Artifacts              | partitioned store (§3)                                                         |
| Vault scope            | credentials and contacts, owner-shared or profile-isolated (§6)                |
| Memories               | future faculty, profile-scoped with a write-authority hierarchy (§9)           |
| Policies               | tool allowlist, gating/auto-approve, initiation rights, budgets, timezone (§7) |

The human's DM with an entity **is** that entity's main chat. Replies that arrive there
wake the entity in the same thread the human reads — no forwarding logic. The human may
also open and interject in any DM thread (it is just a session; the owner is a participant).

## 3. Data model and partitioning

`apps/server/src/identity.ts` remains the seam. The partition key gains a profile
component: `sessionKey(owner, profile, id)` → `"{owner}:{profile}:{id}"`. Doc rows gain a
`profile` field, following the proven v1→v2 owner-stamping migrate in `sessions.ts`.

| Store                       | Today                   | Change                                                                                                                                                    |
| --------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions (`ultiv.sessions`) | `owner` per row         | + `profile`, + `kind` (`main`/`session`/`dm`), + `participants?`; v3 migrate stamps `profile: "default"`, `kind: "session"`                               |
| Conversations               | `owner:id` keys         | `owner:profile:id`; pair threads keyed `owner:pair:{a\|b}` (ids sorted — one thread per pair, both directions)                                            |
| Artifacts                   | one flat dir            | `ARTIFACTS_DIR/{owner}/{profile}/`; tools resolve dir per call from `api.conversationId` → session → profile                                              |
| Cron (`ultiv.cronjobs`)     | global rows             | + `profile` stamp (v2 migrate)                                                                                                                            |
| Webhooks (`ultiv.webhooks`) | global rows             | + `profile` stamp                                                                                                                                         |
| Tasks                       | per-conversation doc    | inherits profile via parent conversation — no change                                                                                                      |
| Audit                       | single JSONL, no fields | + `profile` on entries; tail endpoint filters                                                                                                             |
| Profiles                    | —                       | new `ultiv.profiles` doc + REST CRUD; **not** a chord object (chord 1.4.0 replicated-object attach desyncs; the registry is REST for exactly this reason) |

Existing data: each owner is materialized a `default` profile lazily on first touch. No
data migration beyond the stamps.

`ProfileInfo` (contracts):

```ts
{
  id: string; owner: string; name: string; description: string;
  persona: string;                    // free text, rendered as the entity's section
  timezone: string;                   // IANA; cron renders in this tz
  model: { id: string; effort: string } | null;  // starting default for new chats
  toolAllowlist: string[] | null;     // null = all installed tools
  policies: {
    canInitiate: string[];            // sibling ids this entity may message autonomously
    autoApprove: string[];            // bare tool names ("bash") or tool:glob sub-action rules ("bash:git *")
    approvalTimeout: "deny" | "escalate";
    dailyTurnBudget: number | null;   // model turns/day across the profile
  };
  createdAt: number; archivedAt: number | null;
}
```

## 4. Bot Mode (the main chat)

A session with a well-known id per profile, created with the profile (lazily on first
contact, the `touchSession` pattern). `kind: "main"`: pinned in the UI, not deletable,
only **resettable** — reset rotates to a fresh conversation key and keeps the old
transcript for history. Human inputs, cron fires, and webhook deliveries land here.
Bot-to-bot does **not** land here (§5).

## 5. The inter-entity mailbox

Asynchronous only. A blocking "ask-and-wait" tool is rejected: one entity holding a turn
open while its peer replies through it is a deadlock, and the tasks faculty already proved
the alternative — _end your turn; you will be woken with the result_.

**Threads.** Each entity **pair** gets one durable DM conversation
(`owner:pair:{a|b}`, sorted ids). First message to a sibling ensures the thread lazily and
registers it (`kind: "dm"`, `participants: [a, b]`). Context accumulates per pair: the
Researcher↔CoS working relationship has its own memory, separate from each entity's main
chat. Cross-thread recall ("we discussed this elsewhere") is the memory faculty's job (§9),
never transcript sharing.

**Flow.**

```
CoS (its main chat): message(to: researcher, kind: request, body, artifacts?)
  ├─ envelope admitted into the CoS↔Researcher DM thread (Researcher settles there)
  ├─ CoS's turn ends (tool call already narrates the ask in its own chat)
  └─ on settle: reply digest submitted into CoS's MAIN chat
       as [reply from Researcher • re: {messageId}]  → CoS wakes, synthesizes
Failure: [nack from Researcher • re: {messageId}] … — sender can retry or give up (§5.2)
```

The DM thread holds both sides naturally (envelope as input, reply as assistant entry).
Main chats hold only wake inputs. Fan-out = N pair threads; synthesis lands in the
sender's main chat where the human reads it.

**Envelope** (contracts, also the future federation wire format):

```ts
{
  id: string; chain: string[];         // lineage of profile ids; doubles as trace id
  from: string; to: string;            // profile ids, or "external:{name}"
  kind: "request" | "notify" | "reply" | "nack";
  replyTo: string | null;
  body: string; artifacts: string[];   // cross-profile artifact grants, internal only
  at: number;
}
```

**Delivery semantics** mirror `deliver.ts`: admission is the contract; the turn settles in
the background; a failed turn is a NACK, never a lost delivery. Idempotency by `id`
(at-least-once). Pending state lives in a `ultiv.mailbox` doc (cron/webhooks pattern).

### 5.1 Loop and cost safety

- **Lineage:** refuse delivery when the target is already in `chain` (cycle) or
  `chain.length ≥ 3` (hops). Legitimate relays are ≤ 2 hops; workers reply _up_, never
  sideways — the roster section teaches the org chart, the chain cap enforces it.
- **Initiation tiers:** the mailbox cannot prove from a tool call whether the
  model is executing an owner instruction or acting on its own — so initiation
  is **open by default** (`canInitiate: ["*"]`): every entity can message every
  sibling, and an owner _restricts_ by setting an explicit list (`[]` locks a
  profile out of the mailbox entirely; human/REST sends always pass). Loop
  safety never depended on this list — it lives in the lineage caps, rates and
  budgets below.
- **Budgets:** per-pair rate limit (default 10 msgs/hour) + per-profile
  `dailyTurnBudget`, enforced at the mailbox, audited per send. Every message is a model
  turn; three entities chatting is 3× token burn per exchange.

### 5.2 Failure escalation

Retries capped (default 3 per message), then the mailbox entry goes `dead` and the human
is notified through the attention path (§8). Cron jobs get a consecutive-failure counter →
auto-disable + notify. "Failed turn ≠ failed delivery" stays true at the transport layer;
at the system layer, silence must eventually page the owner.

### 5.3 Vocabulary note

The design deliberately mirrors `@effect/cluster` (`Envelope`, `Entity` addressing,
`MessageStorage`, at-least-once) so internals can later swap to `Sharding` +
`SqlMessageStorage` without touching the mind. As of 2026-10, `@effect/cluster` is
Effect-3-only (peers `effect ^3.22.1`; the repo runs 4.0.6) and would nest a duplicate
Effect runtime — do not import it; re-check when a v4 port lands. Keep one durability
boundary: admission in the mailbox doc, settlement in the harness. No second workflow
engine.

## 6. The vault

Broker, not reader. The model triggers use; secret bytes never transit a transcript.

| Access class           | Examples                                  | Model may                                        |
| ---------------------- | ----------------------------------------- | ------------------------------------------------ |
| `secret` (use-only)    | passwords, API keys, tokens, card numbers | see metadata + masked hint; trigger a redemption |
| `reference` (readable) | contacts, addresses, non-card billing     | search and read freely                           |

**No tool returns a secret — enforced by construction, not policy.** The act surface
exposes `vault_list` (metadata + masks) and contact search only.

- **Kinds:** `login` (url, username, password, TOTP), `card`, `contact`, `key`, `note`.
- **Scope:** each item is `owner`-shared or `profile`-isolated — the partition from §3,
  decided per item. Contacts default per-profile; logins default owner-shared.
- **Connector integration:** a third `AuthSpec` kind
  `{ kind: "vault"; item: string }`; `resolveAuth` decrypts in memory and hands the
  `ConnectorContext` to `perform`. The model-facing action tool is unchanged.
- **Grants (future executors):** computer-use/CLI runners receive short-lived (≤ 60 s),
  single-use, purpose-bound grants (item + consumer + conversation); the executor redeems
  at the vault service and types into the TTY/DOM. The model sees `login filled`.
  Executors must redact known secret values from screenshots — a settings page echoing a
  password routes it back through a vision model otherwise.
- **Entry UX:** human-only, `POST /api/vault/items` from the UI. The model may ask the
  user to add an item; it never carries the bytes. Anything the model touches lands in a
  durable transcript.
- **Crypto:** per-item AES-256-GCM DEK, wrapped by a KEK from `VAULT_KEY`; masked
  previews plaintext; rotation = re-wrap. (Webhook tokens stay plaintext — different
  class.) Later: passphrase-gated unlock + re-lock timer.
- **Threat model:** model vs secrets — by construction + audit (item + action +
  conversation, secret-free). Operator vs secrets — the KEK holder reads all; true of every
  consumer vault; passphrase mode is the mitigation. Infrastructure keys
  (`KENARI_API_KEY` etc.) stay env — the vault is for user-service credentials.

`VaultItemInfo` (contracts): `{ id, owner, profile|null, kind, name, access, masked, createdAt, lastUsedAt }`.

## 7. Attention and contention

- **Cross-profile approval inbox:** one REST/UI list of every pending gate (tool, profile,
  conversation, jump link). The broker's pending map already exists; this is a read
  surface over it plus a push path (one outbound channel — Telegram, email, or desktop
  notification; open decision §12). Timeout behavior per `policies.approvalTimeout`
  (`deny` or `escalate` to the inbox).
- **Gate priority lanes:** the process-wide Gate (default 4) gains priorities —
  human-originated turns preempt bot-originated; per-profile sub-cap (default 2) so any
  one entity cannot starve the owner's typed message.

## 8. Lifecycle

- **Archive:** profile stops (cron disarmed, mailbox rejects sends, chats read-only);
  data intact; unarchive reverses.
- **Delete:** soft-delete (30-day recovery) → hard purge. The purge cascade must reach:
  conversations, artifacts dir, vault items (wrapped blobs + sidecars), cron, webhooks,
  mailbox pendings. Audit entries are retained (append-only legal record) — the row keeps
  the profile id, the data does not. Open decision: transcript retention (§12).
- **Export:** profile bundle (conversations JSON, artifacts, vault wrapped items, config)
  as a zip via REST. Import reverses it into a new profile id.

## 9. Memory (future faculty — design the seam now)

> **Implemented 2026-10-28** — see `docs/MEMORY.md` for the shipped contract.
> Summary of what changed from this section: the hierarchy stands (session →
> profile → owner), write authority is still config, and recall still
> resolves through memory, never transcripts. Added: ranked bilingual recall,
> dated/sourced facts with supersede history (nothing deleted but a Purge),
> an entity graph carried by fact triples, core memory as its own prompt
> section, and a weekly tidy whose proposals change nothing until the owner
> accepts.

Hierarchy: session context (free) → profile memory (the entity's own durable facts) →
owner memory (cross-profile: the user's preferences, not re-taught per entity).

Write authority is config, not goodwill: each store declares which writers may append —
e.g. an owner-designated "memory keeper" profile distills sessions into profile memory;
entities write about themselves; only the designated keeper writes owner memory. Without
this rule, three entities writing overlapping memories is worse than none. Cross-thread
recall (§5) resolves through memory, never transcript sharing.

## 10. Federation (future)

The envelope crosses HTTP: external bots POST an entity's webhook with an envelope;
replies POST back out. External senders carry a provenance class with strictly fewer
rights: no artifact grants, never `canInitiate`, rate-capped harder, and their envelopes
are visually distinct in threads. Internal-first: the same schema, one transport shim.

## 11. Observability

- **Trace view:** `chain` is a trace id. One cron fire → fan-out → replies → synthesis is
  correlatable across transcripts; the activity feed is mailbox events grouped by chain,
  newest first. Cheap to build from the doc.
- **Usage rollup:** per-conversation usage already lives in the projection; per-profile
  spend is a sum over its sessions. Dashboard is a UI concern, the data is already there.
- Every message is an admitted input in a durable conversation: the whole team is
  transcripted and auditable by construction. No opaque multi-agent behavior.

## 12. Open decisions

1. Hop cap value (proposed 3) and per-pair rate default (proposed 10/hour).
2. Notification channel for the approval inbox (Telegram / email / desktop push).
3. `notify` messages with `replyBy` deadlines — cron-friendly reminders? Semantics if the
   deadline passes silently.
4. First autonomous contact between a pair: one-time approval before the budget applies?
5. Transcript retention on hard purge (legal-record audit stays; do transcripts?).
6. DM threads in the UI: nested under each profile, or a Team view grouped by pair?
7. Vault passphrase mode: v1 with `VAULT_KEY` auto-unlock (proposed), passphrase later?
8. Pair-thread rotation: archive a stale DM and start fresh (context reset), or rely on
   compaction + memory only?

## 13. Non-goals / rejected

- **System templates or preset entities** — profiles are user-defined, full stop.
- **Rooms / N-way threads** — turn-taking across N entities is unsolved and unnecessary:
  fan-out + hub synthesis covers the org-chart case. Revisit only with a use case.
- **Synchronous ask-and-wait between entities** — deadlock; async wake pattern only.
- **Profile as a chord replicated object** — chord 1.4.0 attach desync; REST + doc.
- **Per-profile mind processes / runtimes** — one runtime, N identities; profiles are
  data + config, not processes.
- **Importing @effect/cluster today** — Effect-3-only; borrow the vocabulary, not the dep.

## 14. Phasing

- **v1 — Profiles:** profiles CRUD (doc + REST + contracts), session/artifact/cron/webhook
  stamping + migrates, Bot Mode main chat, persona + roster sections, per-profile model
  defaults, tool allowlist, timezone. Archive (not delete).
- **v2 — Mailbox + attention:** DM pair threads, envelope + wake, lineage caps, budgets,
  dead-letter + escalation, approval inbox + one notification channel, Gate lanes,
  soft-delete/purge cascade.
- **v3 — Vault:** store + crypto + REST CRUD, `vault` AuthSpec on one real connector,
  contact references, audit on redemption. Grants follow the first executor.
- **v4 — Memory + federation:** memory hierarchy + write authority, external trust
  classes, export/import hardening.

Each phase passes the full gate (`vp check` → 6× tsc → `vp test` → web build → smoke);
smoke gains the new REST surfaces as it goes. Failure-mode tests (lineage refusal, budget
exhaustion, dead-letter, purge cascade) are part of each phase's definition of done — the
safety rules are the product.

## 15. Documentation impact (when implemented)

- AGENTS.md: "the platform's ONE AI entity" → "one runtime, one entity per profile";
  layout section gains the profiles/vault/mailbox modules.
- `packages/contracts` README/exports: `ProfileInfo`, `MailboxEnvelope`, `VaultItemInfo`,
  extended `SessionInfo`.
- This RFC graduates to the design doc for v1 when implementation starts.

## 16. Addendum (2026-10-26, post-implementation wave 2): rooms

Live testing exposed a root flaw in per-pair DM threads: ONE shared conversation renders
ONE identity section, so both bots in a pair wore the first participant's persona, and
memory/tool scoping in the thread followed the same wrong profile. DM threads as sessions
also polluted session lists with bot-to-bot traffic.

**Rooms replace DM threads.** A room is a contextual conversation (a pair may hold many,
keyed by topic; groups generalize). Every participant gets their OWN conversation
(`{owner}:room:{roomId}:{profileId}`), indexed to their profile — identity, memory, tools
and artifacts scope per-entity, always. Envelopes land in the recipient's seat; replies and
NACKs wake the sender in THEIR seat (never the main chat); rooms are REST-only
(`GET /api/rooms`, `GET /api/rooms/:id` with per-seat transcripts, `POST …/say` for
supervision) and never appear in session lists. The `message` tool gained `topic`.
Legacy `kind: "dm"` session rows are filtered from lists (removable by id).

Also in this wave, from owner feedback:

- **Terminology:** profiles are BOTS in every user-facing surface (wire/code keep the
  `ProfileInfo` names).
- **Lifecycle:** `POST /api/profiles/:id/main` sets the ONE main bot (`GET /api/main`);
  the main bot and the last remaining bot cannot be removed (409).
- **Onboarding:** creating a bot seeds its first main-chat turn from the provided
  name/description/persona (`onboard: false` opts out); `ensureMain` is single-flight.
- **UI:** bots panel (spawn with identity, edit identity, set-main, delete), rooms popup
  with per-seat transcripts + supervision say, vault manager (shared by default, scoping
  optional), "Bot" terminology throughout.

## 17. Addendum — the tunnel model (post-live fixes, 2026-10-26)

- **The room is a tunnel.** An exchange runs between two endpoint conversations:
  the sender's origin thread (main chat, or the session the message was sent
  from) and the counterpart's MAIN thread. Delivery submits the envelope onto
  the recipient's main thread — the thinking, tool calls and drafting happen
  there, in the open, where the owner can read them. The room record carries
  routing only (participants + topic); seats are gone.
- **Signals, not copies.** When the counterpart finishes a request, the
  sender's origin thread is woken with a finish signal (who replied, which
  room, room id) — never a transcript copy. The `room` tool reads a room's
  full envelope transcript from any endpoint; NACKs signal the same way.
- **Session-pinned exchanges.** Every send records its origin conversation:
  an exchange started from a session tunnels back to that session, while the
  counterpart always works on their main thread.
- **Per-exchange cap, acknowledged.** The 3-send budget counts only since the owner's last real instruction on the sending thread (unbracketed input); wake chains are bracketed, so they accumulate to the cap while a fresh owner brief resets it. Human/REST/cron sends are exempt.
- **Tasks run as their bot.** Task conversations are adopted under the spawner's profile scope (kind `task`), so background tasks can message, read/write artifacts and remember as their bot. They stay out of session lists.
- **Artifact grants materialize.** Envelope grants copy the artifact (blob + sidecar) into the recipient's per-profile store at delivery, so `artifact_read` actually resolves granted ids.
- **Per-pair exchange cap, acknowledged (superseded above).** Tool-initiated sends between two
  bots are capped at 3 per sender per sibling (all topics combined);
  human/REST/cron sends are exempt. The `message` tool output reports the
  remaining budget so a bot can acknowledge the limit and conclude.
- **Initiator visibility.** An outgoing `message` call renders in the
  sender's transcript as a visible "✉ → peer" note, not a collapsed trace.
  Bracketed machinery inputs (`[message from …]`, `[reply from …]`, `[nack …]`,
  `[owner]`, `[cron …]`) project as `note` entries; `[onboarding]` is dropped
  from display entirely. The model still sees all of them.
- **Timestamps.** Session transcripts and room timelines render entry timestamps.
