# Security notes

How the server keeps files, owners, webhook tokens and the host shell apart. Each section
names the one helper that enforces it, so a later change has one place to edit.

## Sign-in (passcode and sessions)

Until a passcode is set, the only thing anyone can do is the one-time
"set passcode" step, and only when the client itself is on the machine
(setting the first passcode happens at the machine; it signs that browser
in). The rest of the API and every socket answer the sign-in refusal,
loopback included. The loopback test (`isLoopback` in
`apps/server/src/auth/http.ts`) looks at the client, not the proxy: the web
dev/preview server forwards the client address (`xfwd` in
`apps/web/dev-proxy.ts`), so a phone reaching the app through it is not
loopback; a forwarded request counts only when every `x-forwarded-for` hop
is loopback, and a proxy that hides the client (`forwarded`, `x-real-ip`,
or `x-forwarded-proto` alone) never counts. So the LAN and
the tailnet get the sign-in-required answer from the start. After a passcode exists, every
request needs a session, loopback included.

- The gate is one function, `authorize` in `apps/server/src/auth/guard.ts`,
  and it runs before any route: one refusal shape (`401 {"error": "sign in
  required"}`) for everything, so a probe learns nothing per route.
- The passcode is stored only as a slow hash: scrypt (N=16384, r=8, p=1)
  with a random salt, in `AUTH_DIR/auth.json` (default `auth` in the data folder, 0600).
  Nothing else about it is stored; a wrong passcode never names which part
  was wrong. Writes go to a temp file beside it, then a rename. A damaged
  `auth.json` fails closed: the passcode counts as set and nothing matches
  it, so it never reopens the first-passcode step; the recovery command
  writes a fresh one. A malformed or oversized body on the auth routes is
  answered 400 / 413, never 500.
- Sign-in is throttled: the first wrong attempts answer at once; from the
  fifth, each attempt locks for a doubling wait capped at 15 minutes. The
  right passcode during a lock is refused like any other (`429`, with
  `Retry-After`).
- A signed-in session is a random 32-byte id in an HttpOnly, SameSite=Strict
  cookie (`spriessen_session`), Secure when the request came over HTTPS.
  Sessions expire after 30 idle days (sliding: use refreshes), live in
  `AUTH_DIR/sessions.json`, and are capped at 100 (the oldest falls out).
- As a second fence against cross-site requests (CORS stays `*` by
  decision): a `POST`, `PUT` or `PATCH` under `/api` must name a content
  type a page can only send after a CORS preflight, which the wildcard
  answer fails for requests that carry the cookie. So a missing type and
  the form types (`application/x-www-form-urlencoded`,
  `multipart/form-data`, `text/plain`) get 415, bodyless posts included;
  routes take `application/json`, and raw-byte artifact uploads send
  `application/octet-stream` with the real type in the `mime` query. This
  matters for same-site origins SameSite=Strict does not stop (another app
  on a different localhost port). `contentTypeAllowed` in
  `apps/server/src/auth/guard.ts`.
- Routes that answer without a session: `GET /api/health`, the webhook
  ingress `POST /hooks/:id` (its token is the auth), and `/api/auth/*`
  (status, sign-in, sign-out, setup, change). The first-time setup
  additionally requires the client on the machine; the change and the
  passkey-management routes check the session themselves.
- Changing the passcode needs a session and the current passcode, checked
  under the same throttle as sign-in; a change signs out every other
  session (the one making the change stays).
  **Passkeys** work beside the passcode (WebAuthn, via
  `@simplewebauthn/server`): a signed-in owner adds one in Settings, and the
  sign-in screen offers "Use a passkey" whenever one exists for the site's
  origin. The rp id and origin come from the request's own Host, so
  localhost and the tailnet HTTPS facet each register their own working
  passkey. WebAuthn only runs in a secure context, so a plain-HTTP LAN
  address gets no "Add a passkey" button in Settings (it says why). The
  passcode stays as the fallback and cannot be removed. Sign-out in
  Settings returns the device to the sign-in screen at once.
  Adding and removing a passkey are audited (`passkey-added`,
  `passkey-removed`, kind `auth`).
  Forgotten passcodes: the recovery command (see README) resets the passcode
  and clears every session from the host. Registered passkeys stay: anyone
  holding one can still sign in after a recovery; remove them in Settings.

Tests: `apps/server/src/auth/auth.test.ts`, `store.test.ts`, and
`passkeys.test.ts`: the routes end to end with a software authenticator
(`soft-authenticator.ts`: register, sign in, a replay refused, removal
audited).

## File paths stay inside their folder

Every store that turns a request or tool argument into a file path goes
through `resolveInside(root, ...parts)` from `@spriessen/core`
(`packages/core/src/safe-path.ts`; ext re-exports it for the server).

- The joined path must stay under `root` after resolving: `../`, an absolute
  part (`/etc/passwd`) or a NUL byte is refused. Percent-encoded `..` is
  refused too, because routes decode ids before they reach the store.
- When `root` exists, both sides are resolved with `realpath`: the deepest
  existing part of the target must still sit under the real root, so a
  symlink that points out (to a file or a folder) is refused. A dangling
  symlink is refused as well. A root that is itself reached through a symlink
  is fine.
- The error is `PathEscapeError` (`code: "EPATHESCAPE"`). REST answers it with
  400 and a message that names only the attempted path. Lookups by id
  (artifacts, vault items, skill files) treat an escape as "not found"
  (`tryResolveInside`), so a probe can't tell an escape from a missing item.
- Covered: artifacts (store, REST routes, the `artifact_*` tools, chat
  attachments, file versions and their restore route, profile purge), the
  bot's file tree (`artifact_write` paths, uploads, screenshots and grants
  all go through `putFile` and `treePath`), the durable fs sidecars, the vault, MCP config
  and OAuth files, credential bindings, skills and skill proposals, and the
  local shell backend (which also syncs back only regular files, never
  symlinks, like the VM's `find -type f`).
- Not covered because they take no caller-supplied path: the audit log, push
  subscriptions, `.env` handling and the smoke script.

- The path tools `file_read`, `file_search`, `file_edit` and `file_delete`
  (`packages/ext/src/plugins/files.ts`) take a path relative to the bot's own
  area (`{ARTIFACTS_DIR}/{owner}/{bot}`, the tree bash sees under `/home`).
  They refuse absolute paths, `..`, `.` or empty parts, backslashes, NUL,
  any symlink on the way, a bot folder that links out, and a chat that maps
  to no bot. Reads are open; edit and delete are gated, so Manual, Jev and
  YOLO apply as for any gated tool. After an edit or delete, bash reloads
  the tree before its next script (`fs/workspace-epoch.ts`).
- `artifact_write` takes a path in the same tree, under the same refusals;
  writing a taken path replaces that file and keeps the old bytes as a
  hidden version of the SAME bot's file (`fs/versions.ts`), served by id
  only through the owner-scoped artifact routes. A file another bot grants
  lands in `received/` under a free name, never over one of the recipient's
  files. See docs/BOT-FILES.md.
- `extract_document_text` (same file) reads a PDF or .docx from that tree, or
  a shared artifact by id from the bot's own artifact folder only, so another
  owner's ids come back unknown. The readers (`packages/ext/src/docs/extract.ts`)
  are dependency-free and capped: 25 MB in, 50 MB inflated, 2M characters
  out, 100k per call. No OCR; encrypted PDFs are refused.

- `skill_learn` writes skills with no approval, so it refuses instead: turns
  from outside, text copied from outside content this turn, approval and
  permission talk, secrets and vault values, more than 3 a turn, and any
  save when the bot's learning switch is off. `skill_write` runs the same
  checks (one shared gate); where `skill_learn` refuses for who is asking,
  `skill_write` asks the owner on an owner-only card instead. A background
  task spawned or steered from an outside turn is outside for its whole run
  (the mark is on the task row). See docs/SKILLS.md.

Tests: `packages/core/src/safe-path.test.ts`,
`packages/ext/src/path-confinement.test.ts`,
`packages/ext/src/plugins/files.test.ts` (each tool against `../`, absolute
paths and links, plus the wrong owner),
`packages/mind/src/skills/confinement.test.ts`, and the
"artifact routes stay inside the artifacts folder" block in
`apps/server/src/rest/artifacts.test.ts`.

## The org: teams, roles, reach and grants

One org per install (`ultiv.org` document, `packages/mind/src/org/`): flat
teams (no parent field), bots with exactly one home (`teamId`
null = org bot), members with roles, reach grants and published templates.
The ONE permission decision stays `can(actor, action, resource, view)`
(`apps/server/src/rest/can.ts`): the org owner passes everything; org admins
act at org level across teams; a team admin acts only inside its
own team; a member works their team's resources but never roles,
membership, team settings or flags; a viewer reads. Chats stay private
to whoever started them, whatever the roles — the org level sees only a
team summary (`GET /api/org/teams/:id/summary`: counts, bots,
activity timestamps, never chat contents). A refusal anywhere answers exactly
like a missing item. Approval cards route to their approvers
(`approversFor`): a team bot's card to that team's admins and the
org owner; an org bot's to the org owner and org admins — deciding never
reads the chat.

**Open reach is messaging only** (owner decision, 1 Nov 2026, superseding
the earlier note that listed shared folders and commands among the reach
surfaces): any bot can message any bot, across homes, with the mailbox caps;
each CROSS-HOME message writes a `reach` audit row (`org/reach.ts`, the
mailbox wrapper is wired in `entity.ts`), carrying from, to and the
`message` surface — never content. The only paths between homes are
messaging, the org-wide `/home/org-shared` folder and the org bots'
slice-2d team-folder mounts (both below), plus **grants** for NAMED
VAULT ITEMS (REST `/api/org/grants`), which name the resource, the grantee
home and the action; creating, using and revoking are audited, and a revoke
stops access at once (the broker's granted-credential fallback consults the
live grant table on every spend). Connector grants exist in the org model
but are STORED ONLY — the enforced cross-home path for grants is vault
items (slice 7 below). Beyond those paths, a VM is for its home's bots only
(`bash` runs only in the bot's own home VM — the tool takes no target),
each home's `/home/shared` is usable only by that home's bots (org bots
reach a team's folder only through the
`/home/team-shared/<team id>` mounts below), and `can()` refuses
another home's VM, shared folder and files — for TEAM BOTS, with the
uniform "not found" answer; org bots see every team's folder under
`/home/team-shared` (F-D5) — and, for every bot, another bot's chats,
memory or home and another home's vault items, connectors or settings, the
same way. Messaging itself needs no grant and stays
under the mailbox caps.

**Vault items per home** (phase 4 slice 6): every vault item belongs to one
home — a team or the org. The human create names the team
(`teamId` on `POST /api/vault`); without it the item is an org item.
Rows stored before the field existed read as ORG items (the recorded
decision: owner-level means org) — a team bot therefore no longer
sees them, which is the tightening the org model intends. A bot's reads —
`vault_list`, `vault_contacts` and the broker's credential resolution — see
its own profile's items plus its HOME's shared items; another home's items
are simply absent, and a broker reference that points at one is refused AND
audited (kind `credential`, ok false, the item's name only, never any
secret bytes — `auditRefusal` in `packages/ext/src/broker/http-request-tool.ts`).
Grants keep working unchanged: the granted-credential fallback resolves a
named item across homes and the item's binding still governs hosts, methods
and placement. Tested by `packages/ext/src/vault-home.test.ts`,
`packages/ext/src/plugins/vault.test.ts` and
`packages/ext/src/broker/http-request-tool.test.ts`.

**Connectors per home** (phase 4 slice 7): MCP server config is per home,
not per owner. Storage layout: the org's file keeps its path
(`{MCP_DIR}/{owner}/servers.json`); team D's records live at
`{MCP_DIR}/{owner}/team-<D>/servers.json`, both 0600. `upgradeMcpHomes`
runs at boot (repeatable, like `sealWebhookTokens`): rows stored before the
field existed are stamped as the org's — existing connectors move to the
org in place, and a second run changes nothing. A bot's connector surface —
`connector_list`, `connector_load`/`connector_resources`,
`<server>_<tool>` calls and the management tools — lists and reaches only
its home's connectors: another home's connector is absent from the list and
a call is refused with the uniform `connector not found` (`CONNECTOR_NOT_FOUND`
in `packages/mind/src/mcp/access.ts`, the same answer as for a connector that
does not exist, belongs to another owner, was removed or is not assigned to
the bot; only a host switch that is off says so); a team
bot never sees an org connector, and an org bot never sees a team
connector. A bot's `connector_add` files the new connector in the bot's own
home. The human Connectors screen (REST over the signed-in owner session)
still lists and manages every home's connectors. Connectors stay NEVER
auto-approved: the first-use card and the connector-change cards remain
approval floors in every mode. Connector grants exist in the org model
(`resource.kind "connector"`) but the enforced cross-home path today is
vault items by grant only. Tested by `packages/ext/src/mcp/homes.test.ts`
and `packages/mind/src/mcp/homes.test.ts`.

**A connector's own OAuth client, per home** (phase 4 slice 8): a remote
connector that signs in with a PRE-REGISTERED OAuth client (Google Drive's
remote MCP server is the case in point) takes the client id and secret from
VAULT ITEMS of the connector's own home — the org for an org connector, the
team for a team one. The record in `servers.json` holds only
the item ids (`clientIdItem` / `clientSecretItem`), never the values; the
secret is redeemed in-process at flow time (`clientSecretOf` /
`clientIdOf` in `packages/ext/src/mcp/secrets.ts`), never logged, never
returned in tool output, and every encoded form rides the connector's
scrubber. Redemption is home-scoped: only an owner-level item whose home
matches the connector's counts. Another home's item, a profile-scoped item
and an empty `clientIdItem` all read as "no custom client for this home",
and the flow FALLS BACK to today's mechanism (a plain stored `clientId`,
or the server's dynamic registration); a reference to an item that is gone
entirely stays a plain-worded error. A bot naming a cross-home item for a
connector fails validation ("no vault item …"), because `itemsOf` lists
only the bot's home's items; a key the owner types into a secure field for
a team connector is sealed as an item OF that team
(`teamId` through `askSecrets` → the secret-request store). No real
Google sign-in is verified — the flow is proven against a local mock
authorization server (discovery, PKCE, confidential token exchange,
refresh). Tested by `packages/ext/src/mcp/oauth-homes.test.ts`,
`packages/mind/src/mcp/homes.test.ts` and
`packages/mind/src/secrets/requests.test.ts`.

**Team memory**: a team bot proposes one of its own facts for the
team's shared store; only an admin of that team (or the org
level) accepts or rejects (`POST /api/memory/v2/proposals/:id/(accept|reject)
?team=`); rejection discards; accepted facts are recalled only by the
team's bots.

**Host access** (bash's beyond-VM targets — `target: "host"` and
`target: "node"` — and any host-running tool): effective value is
org AND team AND bot for a team bot, org AND bot for an org bot;
only the org owner flips a switch (the `host-flag` resource in `can()`, F3);
every change writes a `permission` audit row and approves nothing already
queued (F6); `GET /api/org/host-access` returns the matrix with the blocking
level for the UI (F4). The switch is first-in-line everywhere:
the per-call gates (the act's guard, the connector call gate) run BEFORE the
approval broker, so a false switch wins over yolo and over Jev, and a stored
exact-command allow rule sits dormant — not deleted — and applies again the
moment the switch turns on. While the effective value is false the
host-direct tools are absent from the bot's tool list (the stdio
connectors' tools — bash's beyond-VM targets stay in the merged tool but
every host/node call is refused by the per-call gate — see
`hostExcludedTools` in
`packages/mind/src/org/host-switch.ts`); a switch change re-applies every
affected bot's agent, so existing chats lose and regain the tools at once.
The switch FAILS CLOSED: a bot whose profile or org row cannot be read is
treated as switched off (`switchAllows`, `?? false` in the connector boot
path). Excluding tools never touches the rest of the list: the agent's tool
filter is stored as `{remove: [...]}` (names only), so every faculty tool
(`message`, rooms, memory, tasks) and every connector installed later stays;
an explicit allowlist becomes a fixed list over the WHOLE registry, never
just the catalog. At boot every stored conversation is re-synced
(`resyncStored`), which heals chats whose stored list predates this. A
mailbox request to a bot whose tool list has no `message` is answered at
once with a dead-letter reply ("… cannot reply: the message tool is not in
its tool list"), never a silent timeout (`canReply` in
`packages/mind/src/mailbox/delivery.ts`).

Chats hold fewer tools than the bot has. Every conversation that is not a
task (main chats, sessions, DM and webhook thread chats) is offered only
the coordination tools in `CHAT_TOOLS`
(`packages/mind/src/profiles/chat-tools.ts`), stored as the chat's
`modelTools` filter BY NAME, so a tool installed later never widens it; a
`beforeTool` hook refuses any other call a chat makes anyway. The tools
that read or act on the world (web, shell, files, code, outside requests,
connector tools, codemode) run only in task conversations, which keep the
bot's allowlist and the same approvals. This narrows what a chat can be
talked into doing in a single turn (outside content quoted into a chat
cannot reach a work tool there); it is not a second allowlist, and the
allowlist and host-access switch above still bound what a task gets.
Existing chats are healed at boot (`entity-chats.ts`).
A queued host-direct call is refused at DECIDE time when the switch went
false after the card was parked (the `approval` resource's `hostBlocked`,
checked first in `can()`; both decide paths ask `hostSwitchRefusal`).
stdio MCP connectors are host-direct — their server runs as a host process —
so they sit under the same switch: a stdio server under a false switch
refuses calls before any first-use card, its tools cannot be loaded, and it
is left out of the connectors prompt section.

**The main bot's admin tools** (`packages/mind/src/admin/`, plus
`bot_create`): `teams_list`, `team_create`, `team_update`,
`team_delete`, `bot_details`, `bot_update`, `bot_move`, `bot_pause`,
`bot_delete`. Main bot only, decided by `can()` (the `bot-admin` resource,
wired through `authz.mayAdminister`); every other bot gets one refusal,
word for word, before any card. `bot_create`, `bot_update`,
`team_update`, `bot_delete` and `team_delete` park an owner
card; a team delete warns first (refused with the bots' names while
it has any). Each change writes a `permission` audit row. No admin tool
takes a host-access switch or an approval mode from the model: new bots and
teams start with host access off and only the owner turns it on. The
home rules below hold for them as for REST. Tested by
`packages/mind/src/admin/admin-tools.test.ts` and `apps/server/src/rest/can.test.ts`.

**Migration** (`migrateOrg`, repeatable, dry run
`vpr @spriessen/server#org:dry-run`): the workspace becomes the org
"Personal" owned by the account; every existing bot is an org bot with host
access ON (F1 — today's behaviour); no team rows are created; a second
run changes nothing — it stamps bots only on the run that creates the org,
so a bot moved to a team or a switch turned off survives a restart
(the migration runs at every boot). One repair runs every boot: a main bot
found in a team moves back to the org.

**Home rules** (`homeRuleProblem` in `packages/mind/src/org/home-rules.ts`,
asked by the profiles service on create, move, pause, remove and set-main,
so REST and the main bot's tools share one check): the main bot is an org
bot; the org always keeps at least one active bot; the first bot lives in
the org; a team bot cannot be made main. A refusal is a 400 on a
create or move and a 409 elsewhere, with the rule's words. Tested by
`packages/mind/src/org/home-rules.test.ts`. Rollback: rolling the code back leaves the `ultiv.org`
document and the two profile fields, which older code ignores; nothing is
moved or deleted. Tested by `packages/mind/src/org/org.test.ts` (migration,
one-home invariant, flags), `apps/server/src/rest/org.test.ts` (routes,
summary, grants, flags), `apps/server/src/rest/bot-home.test.ts` (a bot's
home must exist; moves audited; the home rules over REST), `apps/server/src/rest/approval-routing.test.ts`,
`apps/server/src/ws-chat-privacy.test.ts`, and the reach/grant tests in
`packages/mind/src/org/reach.test.ts` and
`packages/ext/src/broker/http-request-tool.test.ts`.

## One VM per home (the sandboxed `bash`)

From phase 4 the `bash` tool's microVM belongs to the bot's HOME, not the
bot: the org's bots share the org VM, each team's bots its team
VM (`packages/mind/src/org/home-scope.ts` computes the home's scope dir,
`{ARTIFACTS_DIR}/{owner}/_home/org` or `.../_home/<teamId>`;
`packages/ext/src/shell/sandbox-backend.ts` owns the VM, named
`ultiv-<hash of the scope dir>` — the `ultiv-` prefix is kept on purpose).
Each bot works in its own folder inside the shared VM (`/home/<bot>`,
synced from its artifact tree); `prepare` wipes and refills ONLY that
folder, never another bot's and never `/home/shared`. Embedders that set no
home-scope resolver keep the older per-bot VMs. A VM is for its home's bots
only: the `bash` tool takes no target, so a command never runs in another
home's VM, and a bot's Linux user is provisioned in its home VM only (owner
decision, 1 Nov 2026).

**Every bot in a shared VM runs as its own Linux user (slice 2b).** On a
bot's first use of a VM, ext provisions — idempotently, as root, checking
`/etc/passwd` first (the writable layer persists) — a user named
`bot-<hash of the profile id>` with a FIXED uid from 10000 up (uid 1000 is
the image's `node` user). The uid is allocated once per bot by the mind into
the `ultiv.bot-uids` ledger document and never reused: rows survive bot
removal, and the SAME uid is used in every VM. The user's home is the bot's
own folder, mode 700, so one bot cannot reach another bot's files. At every
VM boot root also remounts `/proc` with `hidepid=2`, so a bot sees only its
own processes. Every bot COMMAND runs as that bot's `uid:gid` — never root
(root stays only for provisioning, `prepare`, the chown handover and the
file sync) — with `USER` set, a per-bot `TMPDIR` under its home, and umask
077, which is also what keeps files a bot drops in the sticky `/tmp` from
being read by other bots. The `/proc` remount is verified against
`/proc/mounts` and a failure FAILS THE BOOT (exit 97, `SETUP_FATAL`): a VM
without hidepid is never used. The other setup steps (chown, chmod,
setfacl, group changes) never fail silently: a failure prints a
`spriessen-setup-warn:` line that the backend logs once per process
(`setup-steps.ts`). Shared folders work under umask 077 by a group
handover, not by ACLs: after every `bash` call the bot itself (never root)
re-groups the files and folders it OWNS and changed during the call in
each writable shared folder to the folder's group, adds group read/write
and, on folders, setgid (`sharedNormalizeScript`, symlinks never matched).
A bot's private files elsewhere stay private. Remaining limits: unprivileged user
namespaces are left on (the optional `user.max_user_namespaces=0` hardening
is not applied), and bind-mounted host folders have no host-side isolation
between bots — on the host every file belongs to the host user.

Each VM provisions `/home/shared` on boot (idempotent, as root): owned by
`root`, group `ultiv-shared` with a fixed per-home gid from 10000 up
(`sharedGid`, stored with the org or team and allocated at creation;
rows stored before the field existed read a deterministic value from
`normalizeOrgState`), mode 2770 (setgid). Group MEMBERSHIP is created at a
bot's first use of that VM (`usermod -aG` in the same provisioning step) and
never pre-created. Files bots put there are group-readable and
group-writable on purpose; treat the folder as untrusted input (F-H).

**The org-wide folder `/home/org-shared` (slice 2c).** One host-side store
per org — `{ARTIFACTS_DIR}/{owner}/_shared/org`, beside the `_home` scope
dirs — is bind-mounted at `/home/org-shared` into the org VM (read-write)
and into EVERY team VM (read-only: the mount refuses writes, so a
team bot's write fails; F-O3 is the read-write alternative). Inside
the VM it is `root:ultiv-org` mode 2775, where `ultiv-org` is one extra
group with its own fixed gid stored with the org (`orgSharedGid`, allocated
at creation as `sharedGid + 1` and never given to a team; legacy rows
read `sharedGid + 1`). Every bot joins `ultiv-org` on its first use of its
home VM, whatever its home. The folder never holds vault values or
connector tokens — that is a docs rule and a line in the `bash` tool
description (there is no mediated shared-folder tool path that could refuse
one); grants remain the way to share vault items.

Known limits of the folder on this host (macOS, Apple virtualization):
POSIX default ACLs and the setgid bit do not cross the virtiofs boundary,
so neither is relied on; the group handover above is what makes a
bash-written file readable and writable by the folder's group (verified
in the real-VM suite). The boot still applies the default ACL where the
filesystem supports it.

**Shared-folder caps (fix 2): what is and is not enforced.** There is no
filesystem quota: the folders are virtiofs bind mounts of host
directories and microsandbox 0.7.11 has no quota setting. The caps are
enforced at the Spriessen tool path (`packages/ext/src/shell/shared-caps.ts`):

- Caps: `orgSharedCapBytes` for `/home/org-shared` (default 1 GiB, the org
  owner edits it with `PATCH /api/org`), and `sharedCapBytes` per
  team for its store — the team VM's `/home/shared` and the
  org VM's `/home/team-shared/<id>` (default 1 GiB, edited by the
  team's admin or the org level with `PATCH /api/org/teams/:id`,
  which writes a `team-shared-cap` permission row). Both have a
  minimum of 1 MiB.
- Enforced: before and after every sandboxed `bash` call the backing host
  directory is measured (an lstat walk that never follows symlinks). Over
  the cap, the folder is remounted READ-ONLY inside the VM (a bind of the
  folder onto itself, remounted ro), and the call's stderr says so. Once it
  is back under the cap, the read-only layer is removed at the next call.
  If the remount fails, every `bash` call by a bot that can write there is
  REFUSED while the folder is over its cap. Verified in the real-VM suite.
- Not enforced: a single call can overshoot (the check runs after the
  fact). While a folder is read-only, bots cannot delete files there either,
  so the owner frees space on the host or raises the cap. The org VM's own
  `/home/shared` lives on the VM disk, not in a host store, so only the VM
  disk bounds it. Files written by host-side paths (the server itself) are
  not counted.
- Audit: every file an ORG bot writes into `/home/org-shared` or
  `/home/team-shared/<id>` during a `bash` call becomes a `shared_write`
  audit row (path inside the VM, size in bytes, area, the team whose
  store it is, and the writing bot; never any content). At most 50 rows
  per call. Team bots' writes in their own `/home/shared` are not
  audited.

**Network is off by default (slice 3).** The org VM and every team VM
boot with a deny-everything microsandbox `NetworkPolicy`
(`allowlistNetwork` in `packages/ext/src/shell/net-policy.ts`): no DNS, no
HTTP, nothing in or out — a request from the VM fails until a host is
allowlisted. Each home stores its own allowlist of named hosts on its org or
team row (`netAllowlist`, at most 64 entries, a hostname like
`api.example.com` or a `*.suffix` for its subdomains; legacy rows read an
empty list). The policy is part of the VM's creation config, so a change
reaches a VM by RECREATING it at its next use — the applied fingerprint is
kept beside the sandbox state (`sandbox-netpolicy/`), and `ensureVm` removes
and re-creates the VM when the stored list no longer matches: running
commands die (the same tradeoff as the F-D6 mount default) and the writable
layer (installed packages) is refilled by the boot provisioning. Who edits:
the org owner or an org admin for the org VM (`PATCH /api/org`,
`netAllowlist`), a team's own admin (or the org level) for that
team's VM (`PATCH /api/org/teams/:id`); a member or a foreign
team's admin reads as a missing team. Every change writes a
`permission` audit row (`org-net-allowlist`, `team-net-allowlist`).
**Full network access is an explicit per-home opt-in (`netOpen`).** When the
owner turns it on (the same PATCH routes, audited as `org-net-open` /
`team-net-open`), the VM's policy becomes allow-all EGRESS — every
host, port and the local network are reachable, the allowlist is ignored —
while ingress stays denied. This turns the sandbox's network isolation OFF
for that home: treat its bots accordingly, and expect nothing in the threat
model's network claims to hold while it is on. The flag is part of the same
create-time fingerprint, so flipping it recreates the VM at its next use.
Open homes also boot an in-guest DoH DNS bridge (`shell/dns-bridge.ts`:
`/tmp/.spriessen-dnsd.py` on `127.0.0.1:53`, forwarding over
DNS-over-HTTPS), pinned first in `/etc/resolv.conf` with the runtime's
gateway resolver kept after it — a workaround for the runtime's forwarder
being observed to answer NXDOMAIN for every name for hours while 443
egress kept working (8 Nov 2026). It never runs on allowlist homes, where
the gateway resolver IS the enforcement of the host list. Open homes also
boot with the TLS interception list emptied (`interceptedPorts([])` in
`allowlistNetwork`): an open home denies nothing, so interception has no
job there and its runtime CA only broke clients whose trust store lacks it
(chromium: `ERR_CERT_AUTHORITY_INVALID`).
TLS interception is bypassed for the policy's allow rules, so a bot's TLS to
an allowlisted host is end to end — no CA is installed in the guest — while
a DENIED host gets an explicit refusal (probe-verified: an off-list or
raw-IP connect answers 403, an allowlisted one 200, and the default VM
cannot even resolve DNS; all of it survives a stop + boot). **What breaks
until hosts are allowlisted:** `curl`, `pip`/`apt`/`npm` installs, `git`
clone/pull/push and every other direct network use inside the VM fail out of
the box; the credential broker and MCP HTTP connectors are unaffected (they
run on the host). DNS is allowed only as far as the allowlisted names need
it; raw addresses are never allowed (rules are by name). Port 53 is open
only to the host resolver the VM is given (microsandbox's `host` group),
never to an arbitrary address. The VM fingerprint covers the image and the
mount list as well as size and allowlist, so a changed mount or image
also recreates the VM.

**VM size per home (slice 4).** The org VM and each team VM are
CREATED with the size stored on their org or team row (`vm`: `cpus`
and `memoryMiB`, set at creation; the defaults 1 CPU / 512 MiB are
`DEFAULT_VM` in `@spriessen/contracts` — the old per-VM constants now only
back legacy rows). Bounds (`vmSettingsProblem`, the dialog's words, applied
on create AND edit in the org service and again over REST): 1–8 CPUs and
128–8192 MiB per VM — the maxima are a DEFAULT set from slice 1's numbers
for a 16 GB-class host (half its cores and RAM), not a recorded owner
decision. On top of the per-VM bounds, the host-capacity rule
(`vmCapacityProblem`) refuses a create or edit that would push the SUM of
all homes' CONFIGURED memory (the org's plus every team's, defaults
counted) past HALF the host's physical RAM (`VM_HOST_MEMORY_FRACTION = 0.5`
of `os.totalmem()`; tests inject a smaller host). This is a configured-sum
HEURISTIC over stored settings — it does not measure what the host holds
right now, how much the hypervisor actually reserves, or other processes'
use; treat it as a sanity cap, not a live capacity meter. Like the network
policy, the size is create-time-only in microsandbox 0.7.11, so the applied
fingerprint beside the sandbox state covers size AND allowlist together
(`vmSpecFingerprint`): an edit removes and recreates the VM at its NEXT
START — running commands die with it — and the PATCH answers with a
`vmNote` field saying the change takes effect then (UI surfacing is still
to come). Probe-verified on this host with real VMs: a 256 MiB VM reads
~229 MiB `MemTotal` in the guest; a process allocating ~1 GiB in it is
OOM-killed while the VM survives; a 1-CPU VM runs four concurrent busy
loops ~4× slower than one (0.19 s vs 0.73 s, `nproc` = 1); four VMs sized
512/256/512/1024 MiB boot in parallel in ~240 ms and each reads its own
size.

Purging a team destroys only that team's VM and mounts;
`/home/org-shared` is untouched. The store is destroyed only with the org.

**Team shared folders in the org VM (slice 2d).** Each team's
shared store — `{ARTIFACTS_DIR}/{owner}/_team/<team id>` — backs BOTH
its own VM's `/home/shared` (a bind mount; it was a writable-layer folder
before slice 2d) and the org VM's `/home/team-shared/<team id>` (the
STORED id, never the name): one store, two mounts, no copy. Ownership is
`root:<team group>` mode 2770 in both, the team's stored gid
used in both VMs so file groups match; the org VM names the group
`ultiv-d<gid>`. Every org bot joins every team's group on its first
use of the org VM; `/etc/group` in the org VM is reconciled at start and on
every team create or delete (`teamGroupReconcileScript` in
`packages/ext/src/shell/team-shared.ts`, fired through
`reconcileTeamGroups`) — missing groups and memberships are added, a
deleted team's group is removed. Team bots get nothing new:
they see only their own `/home/shared` plus `/home/org-shared`, never
another team's folder and never `/home/team-shared`. Org bots are
READ-WRITE in the team folders by default (the alternative — one
read-only mount for all teams — is flagged, F-D8). A team
create or delete does NOT restart the org VM: microsandbox 0.7.11 cannot
change a running VM's mounts (`modify()` covers cpu/memory/env/labels/
workdir/secrets/ports only), but the org VM mounts the parent DIRECTORY
once, and virtiofs shows new host-side store subfolders live — verified by
probe — so only the group reconcile is needed (F-D6). The team store
is deleted with the team's purge (F-D9 default; archiving for 30
days is not decided). The group handover, the caps and the
`shared_write` audit rows above apply to these folders.

**Purge**: deleting a bot never destroys a VM (the VM belongs to its home;
`apps/server/src/rest/bot-purge.ts` answers `sandbox: false`), but it
RETIREES the bot's Linux user from its home's VM — `userdel -r`, which also
removes its shared-folder group membership — immediately when the VM is
running, otherwise marked in a pending-removal file that the VM's next boot
applies and clears (`retireSandboxUser` in
`packages/ext/src/shell/sandbox-backend.ts`). A bot MOVED to another home is
retired from its old home's VM the same way — the entity wires the same
sweep to every move (`profiles.update`, `retireUserFromHome`) — and its
user, with the same stored uid, is provisioned in the new home on its first
`bash` there. A bot that never ran `bash`
has no uid and no user anywhere. Deleting a team destroys the
team's VM — both paths (`DELETE /api/org/teams/:id` and the main
bot's `team_delete`) go through `orgService.removeTeam`, which
tears the VM down best-effort (stop, then remove; bounded 8 s, never failing
the removal; injectable as `openMind`'s `destroyHomeVm`, so tests touch no
runtime; the same route injects `retireBotUser`). The org VM is destroyed
only with the org; the org cannot be deleted today, so no route destroys it.

**Upgrade**: bots that ran in per-bot VMs (`ultiv-<hash of the bot's dir>`)
move to their home's VM by the scope change alone; each bot's files refill
into its folder from its artifact tree on the first call, and that first
`prepare` runs `chown -R uid:gid` over the folder — homes that predate
per-bot users were root-owned, and the bot could not have written them
(the upgrade test: `packages/mind/src/org/home-scope.test.ts`, with the
folder behaviour in `packages/ext/src/plugins/bash-home-scope.test.ts`).
Old per-bot VMs are no longer used and are NOT destroyed automatically —
remove them by hand (`msb rm`) after checking. VM state outside the artifact
tree (installed packages) is lost when a bot's home changes, because the
folder is refilled from artifacts.

Tests: `packages/ext/src/plugins/bash-home-scope.test.ts` (naming,
colocation, prepare isolation, per-bot fallback),
`packages/ext/src/shell/net-policy.test.ts` (the allowlist → policy
construction, the fingerprint marker, the TLS-bypass seam),
`packages/ext/src/shell/sandbox-bot-user.test.ts` (the provisioning, exec
and retire command construction at unit level), `packages/mind/src/org/
bot-users.test.ts` (uid allocation, never-reuse across removal, the home
scope carrying the user, the injected removal sweep), `packages/mind/src/org/
home-scope.test.ts` (the resolver, gid allocation, the rerun-stable
upgrade, the injected team teardown), `packages/mind/src/
org/net-allowlist.test.ts` (the offline default for legacy rows, the
patches, the home scope carrying the right list),
`apps/server/src/rest/net-allowlist.test.ts` (who may edit, the uniform
refusals, the audit rows) and `apps/server/src/rest/home-vm-purge.test.ts`
(a bot purge destroys no VM; a team delete destroys the
team's). The real-VM behaviour (colocation inside one microVM,
per-bot prepare isolation with ownership, mode-700 homes, hidepid=2,
`/tmp` under umask 077, idempotent `useradd` keeping the same uid,
retirement, ownership + hidepid surviving a VM restart, and the slice-3
network behaviour: the offline default, an allowlisted host reachable, an
off-list host and a raw IP refused, the policy surviving a stop + boot,
and a change landing by recreation) was first verified with throwaway probe
VMs on this host. Phase 4 adds an opt-in real-VM suite,
`packages/ext/src/shell/real-vm.test.ts`, which is skipped by default and
reports "NOT VERIFIED" then. With `SPRIESSEN_REAL_VM=1` it boots throwaway
VMs and checks that two bots in one VM cannot read each other's files or
see or kill each other's processes; hidepid; `/tmp` under umask 077;
supplementary groups for the numeric uid:gid; the group handover and the
`shared_write` rows; a new team folder appearing live; org-shared
read-only and no `/home/team-shared` in a team VM; no network path
between VMs and no internet by default; the cap remount in both
directions; a recreate reading as a LOST workspace that re-prepares; and
DNS resolving through the host resolver for an allowlisted name.

**The file sync never deletes on a bad listing (fix 1).** The workspace
listing runs under `set -o pipefail` and THROWS on a non-zero exit. Each
`prepare` writes a random token to `/var/lib/spriessen/ws/`, and the
listing checks it first: a VM that was recreated since the last prepare
(by this session or another) has no token, so the listing throws
`WorkspaceLostError` instead of returning an empty tree. Either error
deletes nothing; the call's output carries a `[sync] warning`, and the next
call prepares again. A recreate bumps the VM generation, so every cached
backend reconnects and re-provisions its bot user. The bash tool also
re-resolves the home on every call and rebuilds the session when the VM
world (name, allowlist, size, mounts, user, caps) changed.

**Cross-home isolation (slice 5).** The isolation line is the whole phase-4
model restated as tests. At unit level, a resource filed under another home
is answered EXACTLY like a missing one for every actor below org level,
every action and every bot-owned resource kind
(`apps/server/src/rest/can.test.ts`, the cross-home block); `can()` has no
resource kind that names a VM, a shared folder, a vault item or a connector,
so another home's VM cannot even be asked for (a type-level probe fails the
typecheck the moment one returns); and no tool parameter or backend method
names a VM — `bash` takes exactly a script, an optional target and an
optional node name, the
`ShellBackend` surface binds the VM in its closure
(`packages/ext/src/shell/isolation.test.ts`), and the home-scope resolver
takes the bot alone (`packages/mind/src/org/home-scope.test.ts`). Open reach
stays messaging-only with its caps
(`packages/mind/src/org/reach.test.ts`: a cross-home send writes its audit
row and org↔team exchanges bind to the same per-pair rate and daily
budgets as any pair).
Real-VM level, throwaway probes on this host (deleted after the run)
re-verified: bots sharing a VM cannot list, read, write or enter each
other's homes, read each other's process environment, or see or kill each
other's processes (hidepid=2), while root and the owner bot keep their
positive controls; a team VM mounts only its own `/home/shared` plus a
read-only `/home/org-shared`, has no `/home/team-shared` and no other
team's folder; the org reaches a team's files only through
`/home/team-shared/<id>` and the write lands in that team's VM at
`/home/shared`; a team cannot write `/home/org-shared` (the read-only
mount refuses); and there is no network path between VMs — a deny-all VM
cannot reach another VM's internal service or the outside, while the same
service and an allowlisted host answer the VM whose policy allows them.

**The read-only browser (slice 9).** `browser_open`
(`packages/ext/src/plugins/browser.ts`) opens ONE url per call, read-only:
it returns the page's rendered text (capped at 20 000 chars) and a PNG
screenshot. There is no clicking, typing, forms, logins or downloads — the
tool cannot be steered to interact with a page. The chromium run happens
INSIDE the bot's own home VM — the same microVM `bash` uses (org VM for org
bots, team VM for team bots), as the bot's own Linux user, with
the same per-call bound (45 s, `timeout -k` wrapped so a hung renderer
cannot hang the tool) — and under that VM's network policy: a page whose
host is off the home's allowlist is unreachable BY CONSTRUCTION (the
network layer refuses it), and with the default deny-all policy every
external page fails. The tool takes no target, so it can never open a page
in another home's VM. Chromium ships in the VM image
(`packages/ext/sandbox/Dockerfile`; a fresh machine or an image upgrade
needs the one-time `docker build` + `msb load`) — the tool NEVER installs
packages at call time; a missing browser answers with an owner-worded
message asking for the image rebuild. Like `web_search`/`web_fetch` the
tool is a pure READ and is NOT gated (no approval card per call), but every
call still rides the audit trail, and a bot with `sandbox: false` has no VM
to run it in, so the tool is absent from that bot's list (the same
exclusion `bash` has). The screenshot is written into the bot's own
`.tmp` inside its mode-700 home (umask 0600, so no other bot in a shared
VM can read it), pulled out over the sandbox fs channel, capped (1280 px
window; the model only gets bytes under the same base64 budget artifact
images use) and stored in that bot's own tree under `screenshots/` — the owner
sees the image card in the app. Page text, page title and screenshot are
UNTRUSTED INPUT (prompt injection): the tool description and output say so.

**The interactive session and the owner's live cast.** `browser_session`
(`packages/ext/src/plugins/browser-session.ts`) drives the SAME in-VM
chromium (one per home VM, profile under `/tmp`, cookies never sealed into
model-readable files): reads are ungated, acts (click/type/press) are
gated (`gatedWhen`: the gate holds exactly those ops), and password fields are refused outright — the model must never
carry a secret to type it. The sanctioned path for a wall is op `takeover`:
the OWNER drives the page through the live cast
(`packages/ext/src/browser/cast.ts`), whose SSE stream and act routes are
owner-scoped exactly like every other takeover route (another owner's row
answers like a missing one). The cast changes no isolation boundary: the
owner's navigations run under the SAME home-VM network policy as the bot's
(the allowlist gates the owner too), the frames are page pixels — untrusted
content shown as an image, never parsed — and the owner's keystrokes are
NEVER logged or audited (a typed password goes browser → TLS → server
memory → the VM's stdin, nothing else; the audit records the takeover's
open and finish, not its driving). The stream is one-way (frames out, acts
in over POST), capped at 30 minutes, and winds down when the last viewer
leaves. The Browsers panel's WATCH view (`GET /api/browser/sessions/:conversationId/cast`)
is the same stream under the `view` decision and has NO act route: only an
open takeover lets the owner touch the page. The session list carries facts
only (url, title, when), never page text. Chromium presents a plain desktop
identity (no `navigator.webdriver`, no "HeadlessChrome" user agent) so
sign-in pages accept the owner's sign-in; that is presentation, not an
isolation claim — the VM's network policy is still the reach gate.

## Owner scoping and the one account

There is exactly one account: the passcode signs you in as `owner`
(`OWNER_ID` in `apps/server/src/identity.ts`), and every request the gate
lets through acts on that account's data. Identity comes from the session
cookie only; the old `x-spriessen-user` / `x-ultiv-user` headers are not
read any more (the CORS header list is unchanged). Every REST route that
touches owner data asks one helper, `apps/server/src/rest/owner-scope.ts`
(`ownsProfile`, `ownsSession`, `ownedTarget`, `ownsRecord`, `ownedRecords`,
`findOwned`), which answers another account's item exactly like a missing
one — same status, same body, so ids can't be probed. Under the helpers sits
the one permission decision, `can(actor, action, resource)`
(`apps/server/src/rest/can.ts`): routes, the approval decide path and the
host capability all ask it, and it is the file a later change (roles,
teams) extends. The host capability (bash's beyond-VM targets —
`target: "host"` and `target: "node"` — and other tools that
run on the server's own machine) belongs to the account's bots today; the
act consults it through `openMind`'s `authz.hostAccess`, and a refusal comes
back to the bot before any approval card exists. The WebSocket accepts
only upgrades with a valid session (`apps/server/src/main.ts`); a link
without one is refused at the handshake. An open socket (chord or `/push`)
is tied to the session it opened under and closed with code 4401 within
seconds of that session ending (sign-out, expiry, a passcode change,
recovery), so a signed-out tab stops receiving anything
(`apps/server/src/auth/socket-sessions.ts`); the web client answers 4401
by showing the sign-in gate.

### Migration of pre-sign-in data

Older installs stored rows under whatever label the old header carried
(`guest`, mostly). On every boot, before the server listens,
`migrateOwners` (`packages/mind/src/migrate/owners.ts`) moves every row,
main-bot entry, task, room and mailbox record with such a label to
`owner`, re-aliases each session's durable conversation key (a new
`ultiv.session-map` entry pointing at the SAME conversation, so no
transcript is orphaned), and copies each v2 memory family's content to the
account's family keys. On disk, the per-owner folders (artifacts, skills,
bot files, MCP work dirs, vault) move with them, and so do the owner
fields stored inside files: artifact sidecars, MCP server records (the
connector access check compares that field, so a stale one would lock the
connector) and vault items (`apps/server/src/auth/migrate-storage.ts`).
Rows, sidecars and push entries stamped `agent` never move. A folder that
already exists under the account is merged: the account's file wins a name
clash (two `servers.json` lists are joined by server id) and each kept-back
file is logged as a warning; so is a memory family the account already had
content in (the old label's copy stays on its old key). It is repeatable
and logs a count when anything moved.

- **Dry run:** `vpr @spriessen/server#owners:dry-run` (server stopped)
  prints what a boot would move, changing nothing.
- **Rollback:** rows keep nothing of the old label behind, but the old
  conversation keys and memory family keys stay in place untouched; push
  subscriptions are moved, not copied; the folder move is a rename. Rolling the CODE back
  restores the old labels' reachability only for data that was never
  moved — a moved row reads `owner`. For a controlled rollback, restore
  the data folder from backup (`~/.spriessen/data`, or `var/` on an install
  from before the home, plus `AUTH_DIR` if the passcode
  should go too). Tested by `packages/mind/src/migrate/owners.test.ts`
  (repeatable, transcripts preserved, old memory keys intact) and the
  storage moves in `apps/server/src/auth/migrate-storage.test.ts`.

Scoped by this helper:

| Route                                                           | Rule                                                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `GET /api/cron`, `GET /api/sensors`, `GET /api/webhooks`        | only records whose session (or, if the session is gone, bot) the caller owns                                       |
| `POST /api/cron`, `POST /api/webhooks`                          | the `sessionId` must be the caller's session, or the caller's bot (its main chat); otherwise 404 `unknown session` |
| `POST /api/webhooks/:id/token`                                  | 404 `unknown webhook` for another owner's id, as for a missing one                                                 |
| `DELETE /api/cron/:id`, `/api/sensors/:id`, `/api/webhooks/:id` | `{ ok: false }` for another owner's id, as for a missing one                                                       |
| `POST /api/webhooks/:id/test`                                   | 404 `unknown webhook`, as for a missing one                                                                        |
| `PATCH /api/cron/:id`, `POST /api/cron/:id/try`                 | 404 `unknown schedule` for another owner's id, as for a missing one                                                |
| `PATCH /api/sensors/:id`, `PATCH /api/webhooks/:id`             | 404 `unknown watch` / `unknown webhook` for another owner's id, as for a missing one                               |
| `GET /api/routines/events`                                      | receipts of the caller's own routines only                                                                         |
| `GET /api/state`, `DELETE /api/state/:bot/:key`                 | the bot must be the caller's (empty list / `{ ok: false }`)                                                        |
| `GET /api/audit`                                                | events of the caller's own bots; unattributed (`profile: null`) events are hidden                                  |
| `GET /api/artifacts?profile=`                                   | another owner's bot lists as empty                                                                                 |
| `POST /api/artifacts?sessionId=`                                | the session must be the caller's                                                                                   |
| `GET`/`DELETE /api/artifacts/:id`                               | another owner's artifact is 404 `unknown artifact` (was 403)                                                       |
| `DELETE /api/artifacts`                                         | clears only the caller's own legacy-root artifacts                                                                 |

Already scoped before, by their own owner checks: sessions, profiles and
memory, mailbox, rooms, skills, tasks, approvals and needs-you, memory v2,
vault, bindings, MCP connectors, push and secrets.

Left as they are, on purpose:

- `POST /hooks/:id` is the public webhook ingress; the token is the auth.
- `/api/models*`, `/api/health` and `/api/server-check` hold no owner data.
- Legacy flat-root artifacts with `owner: null` (from before per-owner
  folders) stay readable by everyone, as before.
- Fire receipts of a deleted routine can't be attributed and stay hidden.

Tests: `apps/server/src/rest/owner-scope.test.ts` (the signed-in account over
the real REST handler), `apps/server/src/rest/wrong-owner.test.ts` (another
owner's bot, chat, files, skills, routines, vault item, task and parked
approval: absent from every list, and each read or write answers exactly
like a missing id), `packages/mind/src/migrate/owners.test.ts` (cross-label
refusals at the mind level), `apps/server/src/auth/auth.test.ts` (the gate),
`apps/server/src/ws-auth.test.ts` (the WebSocket) and `vp run smoke`.

## Webhook tokens are stored as hashes

A webhook URL is `/hooks/<id>?token=<token>` (or the token in an
`x-spriessen-token` header; `x-ultiv-token` is still read). The token is the
only thing that authenticates a sender, so the server keeps just its hash.

- **Stored:** `tokenHash` = `sha256:<64 hex>` of the token, in the
  `ultiv.webhooks` document. A random UUID token has enough entropy that a
  plain SHA-256 is the right tool (no salt or slow hash needed).
- **Checked:** the ingress hashes the presented token and compares the two
  hashes with `timingSafeEqual` (`verifyWebhookToken` in
  `packages/mind/src/webhooks/webhooks.ts`). A wrong token is `401` and a
  counted reject, as before.
- **Shown once:** `POST /api/webhooks` returns the token in its response and
  the app shows the full URL with "Copy it now. It won't be shown again."
  Lists (`GET /api/webhooks`, the `webhook_list` tool) never carry the token
  or its hash. A lost token can't be recovered: **New token**
  (`POST /api/webhooks/:id/token`, owner-scoped) issues a fresh one and the
  old one stops working at once. Webhooks a bot creates with its tool get no
  token in the tool output; their owner issues one with New token.
- **Never logged:** tokens don't appear in logs, receipts, audit events or
  tool output. The startup line logs only a count.

### Who may ask for work through a webhook

The token says a payload came through the right URL, not who wrote it: a
repository's webhook carries anyone's issue comment. A webhook with
`senders` (`{ path, allow }`, `packages/mind/src/webhooks/route.ts`) reads
the sender at that path and lets only the named ones start work. Anyone
else's payload never opens a chat and never starts a turn: on a thread that
already has a chat it is written as a context-only note the bot reads as
data ("context only: this sender may not ask you for work"); otherwise it is
receipted `ignored`. The sender field is the SOURCE's claim, so the gate is
only as strong as the source's own authentication of its users (GitHub and
Slack sign their payloads with the account that acted).

### Migration of existing tokens

On every start, before the server listens, `sealWebhookTokens` replaces any
plaintext `token` in the webhooks document with its `tokenHash`, so existing
URLs keep working unchanged. It is repeatable: a document with no plaintext
left is not touched (no new revision), and it returns how many rows it
sealed (`webhooks: sealed N stored token(s) as hashes`). Until it has run, a
legacy plaintext row is still verified (by hashing it), so there is no window
where a URL fails. Nothing is deleted: every row keeps its id, session,
counters and rejects.

Tested on throwaway stores only (`packages/mind/src/webhooks/token-hash.test.ts`,
MemoryStorage and a temp-dir SQLite file that is grepped afterwards for the
old token) and over REST (`apps/server/src/rest/webhook-tokens.test.ts`).

### Rollback

Code from before this change reads only the plaintext `token` field, so after
a rollback every sealed webhook refuses all calls (`401`); the hash can't be
turned back into the token. To recover after a rollback, delete and
re-create the affected webhooks (or roll forward again, where New token
works). No data is lost either way: the rows, receipts and counters stay.

## The beyond-VM targets' "Always allow"

bash's `host` and `node` targets run a script outside the sandbox — on the
server's own machine, or on a paired node — so a whole-tool or wildcard rule
never covers them (a bare `bash` grant approves the default `vm` target
ONLY). Their card offers **Always allow this exact command on this
computer** instead:

- The rule is stored in the bot's existing allow list
  (`policies.autoApprove`) in the target form: `bash@host:=<script>` for the
  host, `bash@node:<nodeId>:=<script>` for one specific paired node.
- It matches a later call only when the call's input is exactly
  `{ script }` / `{ script, target }` (+ `node`, the paired node's NAME,
  which the gate resolves through the node registry to that stored id) and
  the script is the identical string. No globs (a `*` in the stored script
  is literal), no prefixes, no trimming, no other fields. A different
  script, even one extra space, gets a card as before; a rule for one
  target or node never approves another.
- An exact match is approved even if the script looks destructive: the
  owner approved that very text. Glob (`tool:pattern`) rules keep their
  destructive check.
- The same script can behave differently in a different working directory
  (each target keeps its directory between calls); the rule is about the
  text, as asked.
- Scripts longer than 2,000 characters, empty scripts and calls with any
  other input shape aren't saved; the call stays gated and the decision
  still goes through.
- The rule shows in the bot's **Access** tab by its script, and the ✕ on it
  removes it (a policies patch); the next call of that script asks again.
- Jev never decides either target (`JEV_NEVER_DECIDES` is target-aware) and
  fully automatic (yolo) mode is unchanged for them; the host-access switch
  outranks everything, including yolo and a stored rule (which sits dormant
  while it is off). Old `bash_host:<glob>` entries stay inert.
- Stored `bash_host:=<script>` entries from before the merge are rewritten
  to `bash@host:=<script>` at boot (repeatable; counts only, never logs a
  script); a saved rule keeps approving exactly its script through the
  merged tool.
- When a card's input was edited before approving, the rule covers the
  edited input that actually ran, not the original proposal.

Tests: `packages/mind/src/exact-allow.test.ts`, the exact-rule case in
`packages/mind/src/jev-gate.test.ts`, the target matcher cases in
`packages/mind/src/auto-approve.test.ts`, the round-trip migration in
`packages/mind/src/migrate/shell-targets.test.ts`, and
`apps/server/src/rest/bash-host-always.test.ts` (server saves the rule over
REST, same script runs without a card, other scripts still ask, removing it
brings the card back).

## Paired nodes

A bot can run scripts on one of the owner's other machines with bash's
`target: "node"` (see `docs/THREAT_MODEL.md` for the trust story). The
security shape:

- **Pairing is an owner act.** Settings → Nodes mints a one-time pairing
  token, shown once in the minting response; the server stores only its
  SHA-256 (`ultiv.nodes` doc family, `packages/mind/src/nodes/nodes.ts`).
  The token never appears in any REST read, audit line or log.
- **The agent dials OUT.** The node runs `apps/agent`
  (`@spriessen/agent`, or `spriessen node`), a long-lived process that
  opens the server's `/agent` WebSocket with its token in the upgrade's
  `Authorization: Bearer` header (never the URL, which proxies log; the
  legacy `?token=` query is still read for older agents). The server never
  dials in, one connection per node (a second dial replaces the first), and
  revocation flips the stored status and kills the live dial at once — the
  token then verifies false mid-connection.
- **The token stays out of scripts.** The agent reads it from a 0600 file
  (`--token-file`, refused when other accounts can read it), the env key
  `SPRIESSEN_NODE_TOKEN`, or `--token` (warned: any process of the account
  can read a command line). Scripts never inherit the agent's
  `SPRIESSEN_NODE_*` keys, and every answer is scrubbed of the token's text,
  so `env` or `ps` output never carries it into a transcript. A script runs
  as the owner's account, so a DELIBERATE script can still read what that
  account can (the token file included) — the approval card is the gate.
- **Roots are where a script STARTS, not a jail.** Each node carries
  registered roots (absolute paths); the agent refuses a start directory
  outside them with `resolveInside` (`@spriessen/core`), and the default is
  the first root. The script itself can `cd` anywhere the account can reach
  — nothing in the app contains a node script (docs/THREAT_MODEL.md). A
  roots change reaches a connected agent at once (`roots` frame).
- **Every exec ends.** Each script runs in its own process group; a timeout
  or a stopped turn (`cancel` frame) kills the whole group, and a timeout
  still answers with the partial output and exit 124 (the server waits
  `NODE_EXEC_GRACE_MS` past the agent's timeout). The answer comes when bash
  exits, so a background job the script started never holds the call open.
- **No pairing, no execution.** Zero or ambiguous pairing, an unknown name
  or a revoked row answers the bot a structured, owner-actionable error
  naming the owner's fix.
- **Node execs are audited and bounded**: every result states which node it
  ran on, the audit line carries target + resolved node id, results are
  capped at the bash tool's output cap, and every exec carries a timeout —
  a dead agent is a structured error, never a hang.
