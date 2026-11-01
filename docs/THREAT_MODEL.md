# Threat model

Who can reach what in Spriessen, what escapes the sandbox on purpose, and the
gaps we know about. Each section names the module that enforces it, so a later
change has one place to edit. `docs/SECURITY.md` carries the mechanism-level
detail (path confinement, owner scoping, the org model, webhook token
hashing); this file is the map of trust.

## 1. Who is trusted

| Actor                                                        | Trust                                                                                                                                                                                                                                                 | Boundary they must not cross                                                                                                                                            |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The org owner (signed-in person)                             | Fully trusted. One account today; sign-in is the passcode (and passkeys). The org model (phase 3) adds departments and roles on `can()` for future accounts.                                                                                          | Nobody: the org owner is the top of the model.                                                                                                                          |
| Members (org admins, department admins, members, viewers)    | Modelled in `can()` (`apps/server/src/rest/can.ts`): org admins act at org level; a department admin acts only inside its own department; a member works their department but never roles, settings or flags; a viewer reads.                         | Chats they did not start (contents are creator-only, summaries only for org level); another department; org-level state.                                                |
| Bots (profiles)                                              | Semi-trusted: they run model-chosen tool calls, gated by the approval mode (`policies.approvalMode`) with the owner as the floor.                                                                                                                     | Each other's memory, files, vault, chats; the host shell (without a card AND without the effective host-access flag); the owner's credentials.                          |
| Tasks (background bot turns)                                 | Same trust as their bot: a task runs AS its bot (adopted scope, kind `task`), and inherits its bot's home.                                                                                                                                            | Same as bots, plus they never ask the model outside their own conversation.                                                                                             |
| Other bots, via the mailbox                                  | Semi-trusted senders: messages arrive only through the room tunnel with rate, budget, hop and lineage caps (`packages/mind/src/mailbox/`). Any bot may message any bot across homes (open reach); each cross-home message writes a `reach` audit row. | Direct access to the recipient: a message is data on the recipient's thread, never a tool call.                                                                         |
| Webhook callers                                              | Untrusted. Authenticated only by the show-once token (stored hashed); size, rate and schema gates run before the ack.                                                                                                                                 | Anything but delivering an input into the one session the hook points at.                                                                                               |
| Cron and sensor triggers                                     | Local (the server fires them itself), but their prompts were written earlier, possibly by a bot.                                                                                                                                                      | Same as bots; delivery is admission-only (`deliverToSession`).                                                                                                          |
| MCP servers                                                  | Chosen by the owner, otherwise untrusted: an HTTP/SSE server sees only the tool calls the bot makes to it; a stdio server is a local process (see section 3).                                                                                         | The vault (they receive vault item references, never secret bytes, by construction).                                                                                    |
| Web content (fetched pages, PDF/DOCX extracts, tool results) | Untrusted data. The memory write guard stamps it non-owner and refuses instructions from it; document readers are capped and dependency-free.                                                                                                         | Becoming instructions: nothing a fetched page says is followed, only read. The same holds for bot-to-bot messages and shared-folder files (they flow between all bots). |
| The browser client                                           | The owner's own device. It holds a session cookie; it can do everything the account can, no more.                                                                                                                                                     | What `can()` refuses for its account.                                                                                                                                   |

## 2. What each actor can reach

- **The org model (phase 3)**: one org holds flat departments (no nesting,
  no parent) and bots; every bot has exactly one home — one department or
  the org itself. **Departments are a boundary between bots' VMs, files and
  vaults** (owner decision, 1 Nov 2026): a department bot cannot enter,
  read or run commands in another home's VM, and each home's `/home/shared`
  is for that home's bots only. Messaging and the org-wide
  `/home/org-shared` folder (slice 2c) are the only paths between homes.
  Every resource (bot, memory record, file, skill, vault item, routine,
  sandbox) belongs to exactly one home through its bot (`checkHomes` in
  `packages/mind/src/org/model.ts`).
- **The org owner**, through REST and the chord WebSocket: every route for
  their account. The gate is one module (`apps/server/src/auth/`, the
  session cookie) and one decision helper (`can()` in
  `apps/server/src/rest/can.ts`); what an actor cannot access answers
  exactly like a missing item, so ids cannot be probed. Before a passcode
  is set, a loopback request can only set the first passcode (one-time
  bootstrap); every other request needs a session, loopback included.
- **Open reach is messaging only (owner decision, 1 Nov 2026)**: no reach
  rule limits by department, and the only cross-home reach SURFACE is
  messaging. Every bot, in any home, can message any bot; each cross-home
  message writes a `reach` row (from, to, surface — always `message`, never
  content) into the audit trail (`org/reach.ts`). A VM is for its home's
  bots only: `bash` runs only in the bot's own home VM (the tool takes no
  target), and no bot uses another home's `/home/shared`. The one
  DELIBERATE data path across homes is the org-wide `/home/org-shared`
  folder (slice 2c, flagged F-O1–F-O8 below) — it is a file path, not a
  reach surface, and writes no `reach` rows. Reach does NOT
  cover: another bot's chats, memory or home folder; vault items and
  connectors of another home (those need a NAMED grant, audited, revoked
  stops access at once); department and org settings for anyone without the
  role. Messaging itself is unchanged: admission-only through the mailbox
  with its caps, `canInitiate: ["*"]`.
- **Chats stay private**: a chat belongs to whoever started it — org owner
  and org admins see only a department's summary (counts, bots, activity
  timestamps), never chat contents, over REST or the socket (the socket
  resolves chats through the signed-in account's key space). Approval cards
  route to their approvers (a department bot's card to that department's
  admins and the org owner; an org bot's card to the org owner and org
  admins) — deciding a card never reads the chat.
- **Bots and tasks**: their own conversation (pi-durable, durable-scoped),
  their profile's persona and Instructions files (a department bot also
  inherits its department's standing Instructions, rendered BEFORE its own;
  approval rules outrank any Instructions text), their memory partitions
  (`ultiv.mem.*` doc families per `owner`/profile — plus, for a department
  bot, its department's shared store, written only through admin-accepted
  proposals), their files tree (`{ARTIFACTS_DIR}/{owner}/{bot}`), their
  artifact store partition, their vault scope (contacts readable, secrets
  only through the broker), the tools their allowlist permits, and the
  mailbox/rooms they participate in. The conversation-to-profile index
  (`packages/mind/src/profiles/conversation-index.ts`) is the map every scope
  resolver reads.
- **Webhook callers**: `POST /hooks/:id?token=…` only. The token is verified
  by hash (`verifyWebhookToken`), never stored or logged in the clear; the
  payload is size- and rate-checked, schema-checked when a schema is set, and
  delivered as an input, never executed.
- **The client**: same-origin only (`/api`, `/chord`, `/push`, `/hooks`).
  The session cookie is HttpOnly, SameSite=Strict (Secure over HTTPS), so a
  cross-site page cannot ride it; CORS stays `*` (see gaps) and state-changing
  JSON routes refuse requests that do not carry a JSON content type.
- **Audit**: every executed tool call, approval decision, adjudication,
  sign-in (success and failure), sign-out, passcode change, recovery,
  permission change and vault read lands in the append-only JSONL
  (`packages/mind/src/audit/`); secret-looking values are scrubbed.

## 3. What escapes the sandbox by design

- **Host access has three switches (phase 3)**: org AND department AND bot
  for a department bot; org AND bot for an org bot; every level defaults to
  off for anything created after the migration (the migration turned the
  org and the existing bots on, F1). The effective flag gates every
  host-running tool before any card exists (`effectiveHostAccess` in
  `packages/mind/src/org/model.ts`, consulted through `openMind`'s
  `authz.hostAccess`). Only the org owner may flip a switch; every change
  is audited and approves nothing already queued (F6). A switch that is on
  under an off level is inert and the UI names the blocking level (F4).
- **`bash_host`** runs a script DIRECTLY on the host that runs the server: it
  can read and write everything that account can, including `.env`, the data
  folder, the vault's key material on disk and every bot's files. Nothing in
  the app contains it; the approval system is the only gate (it is always a
  card; Jev never decides it; "Always allow" saves only the exact script
  text, `bash_host:=<script>`). A malicious or steered bot with a yolo-mode
  owner grant is full host compromise; that is why `bash_host` is excluded
  from Jev and from every automatic path.
- **stdio MCP servers** are local processes the owner configured. They run
  with the server account's permissions, see their env (a minimal allowlist
  plus vault-referenced values), and can reach whatever the network allows.
  They are inside the trust boundary the moment they start; only install them
  from sources you trust.
- **The sandboxed `bash`** (microsandbox microVM) is the containment for
  ordinary bot scripts: host files are not mounted, the bot's files tree is
  synced in. From phase 4 the VM belongs to the bot's HOME, not the bot: the
  org's bots share the org VM, a department's bots its department VM, each
  in its own `/home/<bot>` folder beside a shared `/home/shared`. Slice 2b
  gives each bot its own Linux user inside every VM it uses: a fixed uid
  from 10000 up (the same uid everywhere, allocated once and never reused),
  a mode-700 home, `hidepid=2` on `/proc` so it sees only its own
  processes, a per-bot `TMPDIR` and umask 077, and every command run as that
  `uid:gid` — never root. Per-bot users are the inner boundary; the VM
  remains the real one (they are not a defence against kernel bugs or a
  malicious root step). A sandbox escape is out of scope of
  this document (it would be a microsandbox vulnerability), but `bash_host`
  exists precisely because some jobs need the real host.
- **The credential broker** (`packages/ext/src/broker/`) is the only path a
  vault secret takes to the network: sealed item redeemed inside the binding
  (hosts, methods, path prefixes, placement), https only, SSRF/DNS guard,
  redirects drop auth, sizes and timeouts capped, responses scrubbed, audited
  without the secret.

## 4. Known gaps

- **The guest gap (closed in Phase 2, slice 4):** before that slice, a
  request with no owner header ran as `guest`, and `keyForSession` /
  `touchSession` in `packages/mind/src/profiles/sessions.ts` handed any
  session row to `guest`. Identity now comes from the signed-in session only;
  this entry is kept so the history of the gap is explicit.
- **CORS stays `*`** (an owner decision, unchanged in this phase): any origin
  can READ unauthenticated answers (health, sign-in status). A page cannot
  read a credentialed answer (the wildcard does not allow credentials), but
  a "simple" request (a form, or a fetch with no type or `text/plain`) is
  still SENT, and a same-site page (another localhost port) sends it with
  the cookie. SameSite=Strict plus refusing every untyped or form-typed
  state change (see SECURITY.md) are the CSRF defence. A stricter
  same-origin policy would tighten this; not planned.
- **The loopback bootstrap**: before a passcode exists, a loopback request
  can set it (and nothing else). A second local user or process on the
  machine could set the passcode first. A proxied request counts as
  loopback only when every forwarded hop is loopback (the web dev proxy
  forwards the client address), so the LAN and tailnet paths get the
  sign-in-required answer.
- **Recovery is physical**: anyone who can run a command on the host can
  reset the passcode (`vp run --filter @spriessen/server recover:access`) and
  read everything. The host is the trust root; this is the same power
  `bash_host` has.
- **Departments are a boundary between bots' VMs, files and vaults
  (F-A)**: a bot's commands run only in its own home's VM (the `bash` tool
  takes no target; owner decision, 1 Nov 2026) and its files stay in its
  home, so a misled bot's cross-home reach is its messages. The
  conversational blast radius is still the org: any bot can message any
  bot, and message content is untrusted input. Inside a home's VM the
  home's bots share one kernel; the inner boundary is per-bot Linux users
  with `hidepid=2` (slice 2b), the VM remains the real boundary — per-bot
  users are not a defence against kernel bugs or a malicious root step.
  Removing a bot retires its user and shared-folder group membership from
  its home's VM (marked for the next boot when the VM is stopped); a stale
  member would keep shared-folder access, which is why the sweep runs in
  the purge itself. The audit trail is the compensating control; who reads
  it and how loudly is an open question (F-E). Shared folders are an
  injection channel between the bots of one home, and bot-to-bot messages
  between all bots (F-H): every bot message, every shared-folder file and
  every file in `/home/org-shared` is untrusted input, like web content. A
  published template carries no vault items, memory or chats; copies are
  independent from the moment they are made.
- **The org-wide folder is a deliberate leak across departments
  (slice 2c, F-O1–F-O8)**: `/home/org-shared` is mounted read-write in the
  org VM and READ-ONLY in every department VM (F-O8: the read-only mount is
  only as strong as the VM config — the slice test proves a department
  bot's write fails). F-O1: anything an org bot writes there (secrets,
  personal data) becomes readable by every department bot. F-O2: it is a
  prompt-injection channel flowing down from org bots to all department
  bots; treat its content as untrusted input. F-O3: the alternative,
  read-write for all bots, would let a department bot poison every bot —
  not the default. F-O4: it is the first data path across homes and weakens
  the boundary restored on 1 Nov. F-O5: purging a department removes
  nothing from the folder, including anything about that department. F-O6:
  the size cap (default 1 GiB, owner-editable) is enforced only where the
  server mediates writes — `bash` writes are not capped today — and nobody
  is named to back the folder up. F-O7: last write wins, no locking. F-O8:
  see the mount note above. `bash` writes there keep the bot's umask 077
  and, on macOS, neither the setgid group nor POSIX ACLs cross the mount,
  so a bot shares a file deliberately (`chgrp ultiv-org` + `chmod g+r`) or
  not at all (docs/SECURITY.md).
- **One account, many roles on paper**: the role matrix (org admin,
  department admin, member, viewer) is enforced by `can()` and tested, but
  today only the org owner can sign in — no second account exists yet, so
  no non-owner role is reachable on the wire.
- **Web Push payloads** carry names and event kinds only, but the push
  endpoints are visible to the push services; subscriptions live under
  `PUSH_DIR` (0600) and endpoints are SSRF-guarded.
