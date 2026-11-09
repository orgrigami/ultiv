# Threat model

Who can reach what in Spriessen, what escapes the sandbox on purpose, and the
gaps we know about. Each section names the module that enforces it, so a later
change has one place to edit. `docs/SECURITY.md` carries the mechanism-level
detail (path confinement, owner scoping, the org model, webhook token
hashing); this file is the map of trust.

## 1. Who is trusted

| Actor                                                        | Trust                                                                                                                                                                                                                                                 | Boundary they must not cross                                                                                                                                            |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The org owner (signed-in person)                             | Fully trusted. One account today; sign-in is the passcode (and passkeys). The org model (phase 3) adds teams and roles on `can()` for future accounts.                                                                                                | Nobody: the org owner is the top of the model.                                                                                                                          |
| Members (org admins, team admins, members, viewers)          | Modelled in `can()` (`apps/server/src/rest/can.ts`): org admins act at org level; a team admin acts only inside its own team; a member works their team but never roles, settings or flags; a viewer reads.                                           | Chats they did not start (contents are creator-only, summaries only for org level); another team; org-level state.                                                      |
| Bots (profiles)                                              | Semi-trusted: they run model-chosen tool calls, gated by the approval mode (`policies.approvalMode`) with the owner as the floor.                                                                                                                     | Each other's memory, files, vault, chats; the host shell (without a card AND without the effective host-access flag); the owner's credentials.                          |
| Tasks (background bot turns)                                 | Same trust as their bot: a task runs AS its bot (adopted scope, kind `task`), and inherits its bot's home.                                                                                                                                            | Same as bots, plus they never ask the model outside their own conversation.                                                                                             |
| Other bots, via the mailbox                                  | Semi-trusted senders: messages arrive only through the room tunnel with rate, budget, hop and lineage caps (`packages/mind/src/mailbox/`). Any bot may message any bot across homes (open reach); each cross-home message writes a `reach` audit row. | Direct access to the recipient: a message is data on the recipient's thread, never a tool call.                                                                         |
| Webhook callers                                              | Untrusted. Authenticated only by the show-once token (stored hashed); size, rate and schema gates run before the ack.                                                                                                                                 | Anything but delivering an input into the one session the hook points at.                                                                                               |
| Cron and sensor triggers                                     | Local (the server fires them itself), but their prompts were written earlier, possibly by a bot.                                                                                                                                                      | Same as bots; delivery is admission-only (`deliverToSession`).                                                                                                          |
| MCP servers                                                  | Chosen by the owner, otherwise untrusted: an HTTP/SSE server sees only the tool calls the bot makes to it; a stdio server is a local process (see section 3).                                                                                         | The vault (they receive vault item references, never secret bytes, by construction).                                                                                    |
| Web content (fetched pages, PDF/DOCX extracts, tool results) | Untrusted data. The memory write guard stamps it non-owner and refuses instructions from it; document readers are capped and dependency-free.                                                                                                         | Becoming instructions: nothing a fetched page says is followed, only read. The same holds for bot-to-bot messages and shared-folder files (they flow between all bots). |
| The browser client                                           | The owner's own device. It holds a session cookie; it can do everything the account can, no more.                                                                                                                                                     | What `can()` refuses for its account.                                                                                                                                   |

## 2. What each actor can reach

- **The org model (phase 3)**: one org holds flat teams (no nesting,
  no parent) and bots; every bot has exactly one home — one team or
  the org itself. **Teams are a boundary between bots' VMs, files and
  vaults** (owner decision, 1 Nov 2026) — against team bots: a
  team bot cannot enter, read or run commands in another home's VM,
  and no bot uses another home's `/home/shared` except the org bots through
  the slice-2d mounts. Messaging, `/home/org-shared`, the slice-2d
  team folders in the org VM and grants for named vault items are the
  only paths between homes.
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
  rule limits by team, and the only cross-home reach SURFACE is
  messaging. Every bot, in any home, can message any bot; each cross-home
  message writes a `reach` row (from, to, surface — always `message`, never
  message) into the audit trail (`org/reach.ts`). A VM is for its home's
  bots only: `bash` runs only in the bot's own home VM (the tool takes no
  target), and no bot uses another home's `/home/shared` (org bots reach a
  team's only through the slice-2d mounts in the org VM). The DELIBERATE
  data paths across homes are the org-wide `/home/org-shared` folder
  (slice 2c) and the slice-2d team folders in the org VM — both
  flagged below (F-O1–F-O8, F-D1–F-D9); they are file paths, not reach
  surfaces, and write no `reach` rows. Grants for NAMED VAULT ITEMS are the
  only other cross-home path. Reach does NOT
  cover: another bot's chats, memory or home folder; vault items of another
  home (a named grant is the only way to share one — audited, revoked stops
  access at once); or connectors of another home (connector grants exist in
  the org model but are STORED, NOT ENFORCED — a granted connector is not
  reachable across homes today, slice 7). From slice 6 a vault item CARRIES its home
  (legacy owner-level items read as the org): a bot's vault reads —
  `vault_list`, `vault_contacts` and the broker's credential resolution —
  never list another home's items, and a refused cross-home credential read
  writes an audited `credential` row (ok false). From slice 7 MCP
  connectors are per home as well: config under `MCP_DIR` is stored per
  home (the org's `servers.json` path unchanged, team connectors in
  `team-<id>/`), the boot upgrade stamps existing connectors as the org's,
  a bot lists and calls only its home's connectors (a cross-home call is
  refused), and connectors are never auto-approved. From slice 8 a
  connector's PRE-REGISTERED OAuth client (Google Drive's remote MCP
  server) lives as vault items OF the connector's home: `servers.json`
  holds the item ids only, the secret is redeemed in-process at flow time
  and never logged or shown, and a lookup that names another home's item
  (or a profile-scoped one) reads as absent — the sign-in falls back to a
  plain stored `clientId` or dynamic registration rather than crossing
  homes. A team
  connector's keys typed in a secure field are sealed as items OF that
  team, so a team's Google client never sits in the org's
  vault. Team and org
  settings are hidden from anyone without the
  role. Messaging itself is unchanged: admission-only through the mailbox
  with its caps, `canInitiate: ["*"]`.
- **Chats stay private**: a chat belongs to whoever started it — org owner
  and org admins see only a team's summary (counts, bots, activity
  timestamps), never chat contents, over REST or the socket (the socket
  resolves chats through the signed-in account's key space). Approval cards
  route to their approvers (a team bot's card to that team's
  admins and the org owner; an org bot's card to the org owner and org
  admins) — deciding a card never reads the chat.
- **Bots and tasks**: their own conversation (pi-durable, durable-scoped),
  their profile's persona and Instructions files (a team bot also
  inherits its team's standing Instructions, rendered BEFORE its own;
  approval rules outrank any Instructions text), their memory partitions
  (`ultiv.mem.*` doc families per `owner`/profile — plus, for a team
  bot, its team's shared store, written only through admin-accepted
  proposals), their one file tree (`{ARTIFACTS_DIR}/{owner}/{bot}`: artifacts,
  uploads, screenshots, received grants and earlier versions alike), their
  vault scope (contacts readable, secrets
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

- **Host access has three switches (phase 3, enforced first-in-line in
  slice 10)**: org AND team AND bot for a team bot; org AND bot
  for an org bot; every level defaults to off for anything created after the
  migration (the migration turned the org and the existing bots on, F1). The
  effective flag gates every host-running tool before any approval decision
  exists — yolo and Jev cannot bypass it, and a stored allow rule sits
  dormant while off (`effectiveHostAccess` in
  `packages/mind/src/org/model.ts`, consulted through `openMind`'s
  `authz.hostAccess`). While off, the host-direct tools are absent from the
  bot's tool list; while on, the approval rules apply as before. Only the
  org owner may flip a switch; every change is audited and refuses calls
  already queued at decide time (F6). A switch that is on under an off level
  is inert and the UI names the blocking level (F4).
- **bash's beyond-VM targets** run a script DIRECTLY on a real machine:
  `target: "host"` on the host that runs the server (it can read and write
  everything that account can, including `.env`, the data folder, the
  vault's key material on disk and every bot's files), and `target: "node"`
  on a paired machine of the owner's (where their real repos live). Nothing
  in the app contains either; the approval system is the only gate (a call
  is always a card; Jev never decides either target; "Always allow" saves
  only the exact script text — `bash@host:=<script>`, or
  `bash@node:<nodeId>:=<script>` for that one node). A malicious or steered
  bot with a yolo-mode owner grant is full compromise of that machine; that
  is why both targets are excluded from Jev and from every automatic rule
  form (bare grants and patterns cover the default `vm` target only).
- **The node agent is a privileged process on the owner's machine** (phase
  6). It dials OUT to the server's `/agent` WebSocket with a pairing token
  (shown once at pairing, stored hashed, sent as a Bearer header; the server
  never dials in), and starts each script inside the roots the owner
  registered — the agent itself refuses a start directory outside them
  (`resolveInside`). Roots are NOT a jail: the script runs as the owner's
  account and can `cd` or read anywhere that account can, the token file
  included (scripts never inherit the token through the environment and
  answers are scrubbed of it, which stops accidents, not intent). The
  approval card is the only gate. Revocation kills the token and the live
  dial at once. A compromised node agent is compromise of that
  machine; the token only lets it run scripts the owner's bot sends, and
  every one rides the same beyond-VM gate (paired AND host-access switch
  on AND an exact-script rule or yolo). Root runs only where the owner
  runs it; the agent never suggests or needs elevation.
- **stdio MCP servers** are local processes the owner configured. They run
  with the server account's permissions, see their env (a minimal allowlist
  plus vault-referenced values), and can reach whatever the network allows.
  They are inside the trust boundary the moment they start; only install them
  from sources you trust. Their tools are HOST-DIRECT (slice 10): a stdio
  connector sits under the same three-switch flag as bash's beyond-VM
  targets, refuses
  calls before any card while the effective flag is false, and its tools
  leave the bot's list until the switch turns back on.
- **The sandboxed `bash`** (microsandbox microVM) is the containment for
  ordinary bot scripts: the bot's file tree is synced in from its store,
  and the only host folders inside a VM are the sanctioned bind mounts —
  each home's `/home/shared`, the org-wide `/home/org-shared`, and in the
  org VM the `/home/team-shared/<team id>` stores. From phase 4 the
  VM belongs to the bot's HOME, not the bot: the
  org's bots share the org VM, a team's bots its team VM, each
  in its own `/home/<bot>` folder beside a shared `/home/shared`. Slice 2b
  gives each bot its own Linux user inside every VM it uses: a fixed uid
  from 10000 up (the same uid everywhere, allocated once and never reused),
  a mode-700 home, `hidepid=2` on `/proc` so it sees only its own
  processes, a per-bot `TMPDIR` and umask 077, and every command run as that
  `uid:gid` — never root. Per-bot users are the inner boundary; the VM
  remains the real one (they are not a defence against kernel bugs or a
  malicious root step). A sandbox escape is out of scope of
  this document (it would be a microsandbox vulnerability), but bash's
  beyond-VM targets exist precisely because some jobs need the real host.
- **Network is off by default in every VM (slice 3)**: the org VM and each
  team VM boot deny-everything; a home's stored allowlist of named
  hosts (its org or team row) opens exactly those. A team bot's
  VM can therefore not exfiltrate anywhere but its own allowlist, and the
  org VM only where the org level allows. The org owner or an org admin
  edits the org VM's list; a team's own admin, their team's;
  every change is audited (`permission` rows). An allowlist entry is an
  exfiltration channel to that host — allowlist deliberately, treat
  allowlisted-host content as untrusted input like any web fetch. Until a
  host is allowlisted, `curl`, `pip`, `git` and every other direct network
  use inside the VM fails (docs/SECURITY.md has the details). The one
  exception is an explicit per-home OWNER OPT-IN, `netOpen`: full network
  access, allowlist ignored, ingress still denied. While it is on, NONE of
  this section's network bounds hold for that VM — no exfiltration bound,
  no off-list refusals — and the flag is audited (`org-net-open`,
  `team-net-open`) so the departure from the default is on the record.
- **VM size is capped per home and against the host (slice 4)**: the org VM
  and each team VM are created with their row's stored `vm` settings
  (defaults 1 CPU / 512 MiB), bounded at 1–8 CPUs and 128–8192 MiB, and a
  create or edit is refused when the SUM of all homes' CONFIGURED memory
  would pass half the host's RAM. That sum is a heuristic over stored
  settings, not a live measurement — a home inside the cap can still run
  its VM hard (a browser, a memory hog) and starve the host's other VMs;
  the cap bounds configuration, not runtime behaviour. A size edit takes
  effect only when the VM is recreated at its next start, and running
  commands die with the recreation (the F-D6 tradeoff).
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
  bash's `host` target has (and a paired node's agent has over its own
  machine).
- **Teams are a boundary between bots' VMs, files and vaults
  (F-A)**: a bot's commands run only in its own home's VM by default (the
  merged `bash` tool's other targets are gated separately; owner decision,
  1 Nov 2026) and its files stay in its
  home, so a misled bot's cross-home reach is its messages. The
  conversational blast radius is still the org: any bot can message any
  bot, and message content is untrusted input. Inside a home's VM the
  home's bots share one kernel; the inner boundary is per-bot Linux users
  with `hidepid=2` (slice 2b), the VM remains the real boundary — per-bot
  users are not a defence against kernel bugs or a malicious root step.
  **Network is off by default (slice 3)**: a VM reaches only its home's
  stored allowlist of named hosts (deny-everything otherwise, raw IPs
  never); a misled bot's network reach is bounded by that list, and the
  read-only browser (slice 9) runs under the SAME policy — `browser_open`
  opens one page at a time inside the bot's own home VM (no clicking,
  typing, forms or logins), so an off-allowlist url is refused by the
  network layer and with the default deny-all no external page loads at
  all. Page content is untrusted input, and a screenshot can carry the
  same injection (rendered text and images alike). The known cost: bots that
  used `curl`, `pip` or `git` in a VM stop until their host is allowlisted.
  The same `netOpen` opt-in removes these bounds for its home: an open VM
  loads any page in the read-only browser and reaches any host — isolation
  off, by explicit owner choice.
  The INTERACTIVE browser (`browser_session`) is one chromium per home VM,
  run by a broker as the VM's `spbrowser` user and reachable only through
  the server's root exec — never from a bot's `bash` (no debug port, a
  0700 socket) — with one private context (cookies) per bot. Its known
  cost: chromium runs `--no-sandbox` inside the VM, so a page that escapes
  the renderer lands as `spbrowser` and can reach EVERY bot's browser
  context in that home (their sign-ins included), where per-bot browsers
  would have exposed only one; the VM boundary and the network policy
  still hold. Saved sign-ins (sealed cookies) let later tasks act as the
  owner on those sites; acts stay gated and the owner's Forget clears them.
  A separate browser VM per home is the planned answer if this outgrows the
  memory saving.
  Removing a bot retires its user and shared-folder group membership from
  its home's VM (marked for the next boot when the VM is stopped); a stale
  member would keep shared-folder access, which is why the sweep runs in
  the purge itself. The audit trail is the compensating control; who reads
  it and how loudly is an open question (F-E). Shared folders are an
  injection channel between the bots of one home, and bot-to-bot messages
  between all bots (F-H): every bot message, every shared-folder file and
  every file in `/home/org-shared` is untrusted input, like web content. A
  published template carries no vault items, memory or chats; copies are
  independent from the moment they are made. Bind-mounted host folders have
  NO host-side isolation between bots: inside the VM uids hold, but on the
  host every file belongs to the host user, so a host-side process or
  another mount of the same store sees every bot's files (docs/SECURITY.md).
- **The org-wide folder is a deliberate leak across teams
  (slice 2c, F-O1–F-O8)**: `/home/org-shared` is mounted read-write in the
  org VM and READ-ONLY in every team VM (F-O8: the read-only mount is
  only as strong as the VM config — the slice test proves a team
  bot's write fails). F-O1: anything an org bot writes there (secrets,
  personal data) becomes readable by every team bot. F-O2: it is a
  prompt-injection channel flowing down from org bots to all team
  bots; treat its content as untrusted input. F-O3: the alternative,
  read-write for all bots, would let a team bot poison every bot —
  not the default. F-O4: it is the first data path across homes and weakens
  the boundary restored on 1 Nov. F-O5: purging a team removes
  nothing from the folder, including anything about that team. F-O6:
  the size cap (default 1 GiB, owner-editable) is enforced at the `bash`
  tool path, not by a filesystem quota: over the cap the folder turns
  read-only in the VM (or `bash` is refused for the bots that can write
  there), and one call can overshoot; nobody is named to back the folder
  up. Org bots' writes there are audited per file (`shared_write`: path,
  size, bot; no content). F-O7: last write wins, no locking. F-O8: see the
  mount note above. Under umask 077 a bash-written file is handed to the
  folder's group after each call, so every bot of the folder can read and
  write it: anything written there is shared by design (docs/SECURITY.md,
  "Shared-folder caps").
- **Team shared folders in the org VM (slice 2d, F-D1–F-D9)**: the
  org VM mounts every team's shared store at
  `/home/team-shared/<team id>`, read-write. F-D1: a prompt-injected
  org bot can read them all and write to them; content flows both ways
  between org bots and every team bot — untrusted input. F-D2:
  secrets in team shared files become readable by every org bot.
  F-D3: this is one-way file reach (org to teams) after the owner
  removed one-way reach for VMs; the team boundary now holds only
  against team bots. F-D4: org bots can plant files team bots
  read and act on. F-D5: the uniform "not found" rule for another
  team's shared folder holds for TEAM bots only — org bots see
  every team's id under `/home/team-shared` and its group in
  `/etc/group`. F-D6: microsandbox cannot change a running VM's mounts, but
  the parent-folder mount makes new stores appear live, so a team
  create or delete never restarts the org VM or kills running org-bot
  commands (verified by probe). F-D7: the org VM's group count grows with
  the teams; no limit is set. F-D8: read-write is the default; the
  alternative (one read-only mount for all teams) is not selected.
  F-D9: the org VM's capacity matters more now, and the purge default
  deletes a team's store with it (archiving is not decided). Each
  team store has its own cap (`sharedCapBytes`, default 1 GiB,
  enforced like the org-wide one), and org bots' writes into it are
  audited per file.
- **One account, many roles on paper**: the role matrix (org admin,
  team admin, member, viewer) is enforced by `can()` and tested, but
  today only the org owner can sign in — no second account exists yet, so
  no non-owner role is reachable on the wire.
- **Web Push payloads** carry names and event kinds only, but the push
  endpoints are visible to the push services; subscriptions live under
  `PUSH_DIR` (0600) and endpoints are SSRF-guarded.
