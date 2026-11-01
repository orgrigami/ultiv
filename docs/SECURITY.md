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
  with a random salt, in `AUTH_DIR/auth.json` (default `var/auth`, 0600).
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
  attachments, profile purge), the durable fs sidecars, the vault, MCP config
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

## The org: departments, roles, reach and grants

One org per install (`ultiv.org` document, `packages/mind/src/org/`): flat
departments (no parent field), bots with exactly one home (`departmentId`
null = org bot), members with roles, reach grants and published templates.
The ONE permission decision stays `can(actor, action, resource, view)`
(`apps/server/src/rest/can.ts`): the org owner passes everything; org admins
act at org level across departments; a department admin acts only inside its
own department; a member works their department's resources but never roles,
membership, department settings or flags; a viewer reads. Chats stay private
to whoever started them, whatever the roles — the org level sees only a
department summary (`GET /api/org/departments/:id/summary`: counts, bots,
activity timestamps, never chat contents). A refusal anywhere answers exactly
like a missing item. Approval cards route to their approvers
(`approversFor`): a department bot's card to that department's admins and the
org owner; an org bot's to the org owner and org admins — deciding never
reads the chat.

**Open reach is messaging only** (owner decision, 1 Nov 2026, superseding
the earlier note that listed shared folders and commands among the reach
surfaces): any bot can message any bot, across homes, with the mailbox caps;
each CROSS-HOME message writes a `reach` audit row (`org/reach.ts`, the
mailbox wrapper is wired in `entity.ts`), carrying from, to and the
`message` surface — never content. Nothing else crosses homes: a VM is for
its home's bots only (`bash` runs only in the bot's own home VM — the tool
takes no target), each home's `/home/shared` is usable only by that home's
bots, and `can()` refuses another home's VM, shared folder and files,
another bot's chats, memory or home, and another home's vault items,
connectors or settings with the uniform "not found" answer. Those need a
**grant** (REST `/api/org/grants`), which names the resource, the grantee
home and the action; creating, using and revoking are audited, and a revoke
stops access at once (the broker's granted-credential fallback consults the
live grant table on every spend). Messaging itself needs no grant and stays
under the mailbox caps.

**Department memory**: a department bot proposes one of its own facts for the
department's shared store; only an admin of that department (or the org
level) accepts or rejects (`POST /api/memory/v2/proposals/:id/(accept|reject)
?department=`); rejection discards; accepted facts are recalled only by the
department's bots.

**Host access** (`bash_host` and any host-running tool): effective value is
org AND department AND bot for a department bot, org AND bot for an org bot;
only the org owner flips a switch (the `host-flag` resource in `can()`, F3);
every change writes a `permission` audit row and approves nothing already
queued (F6); `GET /api/org/host-access` returns the matrix with the blocking
level for the UI (F4).

**The main bot's admin tools** (`packages/mind/src/admin/`, plus
`bot_create`): `departments_list`, `department_create`, `department_update`,
`department_delete`, `bot_details`, `bot_update`, `bot_move`, `bot_pause`,
`bot_delete`. Main bot only, decided by `can()` (the `bot-admin` resource,
wired through `authz.mayAdminister`); every other bot gets one refusal,
word for word, before any card. `bot_create`, `bot_update`,
`department_update`, `bot_delete` and `department_delete` park an owner
card; a department delete warns first (refused with the bots' names while
it has any). Each change writes a `permission` audit row. No admin tool
takes a host-access switch or an approval mode from the model: new bots and
departments start with host access off and only the owner turns it on. The
home rules below hold for them as for REST. Tested by
`packages/mind/src/admin/admin-tools.test.ts` and `apps/server/src/rest/can.test.ts`.

**Migration** (`migrateOrg`, repeatable, dry run
`vpr @spriessen/server#org:dry-run`): the workspace becomes the org
"Personal" owned by the account; every existing bot is an org bot with host
access ON (F1 — today's behaviour); no department rows are created; a second
run changes nothing — it stamps bots only on the run that creates the org,
so a bot moved to a department or a switch turned off survives a restart
(the migration runs at every boot). One repair runs every boot: a main bot
found in a department moves back to the org.

**Home rules** (`homeRuleProblem` in `packages/mind/src/org/home-rules.ts`,
asked by the profiles service on create, move, pause, remove and set-main,
so REST and the main bot's tools share one check): the main bot is an org
bot; the org always keeps at least one active bot; the first bot lives in
the org; a department bot cannot be made main. A refusal is a 400 on a
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
bot: the org's bots share the org VM, each department's bots its department
VM (`packages/mind/src/org/home-scope.ts` computes the home's scope dir,
`{ARTIFACTS_DIR}/{owner}/_home/org` or `.../_home/<departmentId>`;
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
being read by other bots. The same umask applies in `/home/shared`: the
setgid directory gives a shared file the right GROUP, not readability — a
bot that means to share a file must relax its mode (`chmod`), which keeps
accidental writes private by default. Remaining limits: unprivileged user
namespaces are left on (the optional `user.max_user_namespaces=0` hardening
is not applied), and bind-mounted host folders have no host-side isolation
between bots — on the host every file belongs to the host user.

Each VM provisions `/home/shared` on boot (idempotent, as root): owned by
`root`, group `ultiv-shared` with a fixed per-home gid from 10000 up
(`sharedGid`, stored with the org or department and allocated at creation;
rows stored before the field existed read a deterministic value from
`normalizeOrgState`), mode 2770 (setgid). Group MEMBERSHIP is created at a
bot's first use of that VM (`usermod -aG` in the same provisioning step) and
never pre-created. Files bots put there are group-readable and
group-writable on purpose; treat the folder as untrusted input (F-H).

**Purge**: deleting a bot never destroys a VM (the VM belongs to its home;
`apps/server/src/rest/bot-purge.ts` answers `sandbox: false`), but it
RETIREES the bot's Linux user from its home's VM — `userdel -r`, which also
removes its shared-folder group membership — immediately when the VM is
running, otherwise marked in a pending-removal file that the VM's next boot
applies and clears (`retireSandboxUser` in
`packages/ext/src/shell/sandbox-backend.ts`). A bot that never ran `bash`
has no uid and no user anywhere. Deleting a department destroys the
department's VM — both paths (`DELETE /api/org/departments/:id` and the main
bot's `department_delete`) go through `orgService.removeDepartment`, which
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
`packages/ext/src/shell/sandbox-bot-user.test.ts` (the provisioning, exec
and retire command construction at unit level), `packages/mind/src/org/
bot-users.test.ts` (uid allocation, never-reuse across removal, the home
scope carrying the user, the injected removal sweep), `packages/mind/src/org/
home-scope.test.ts` (the resolver, gid allocation, the rerun-stable
upgrade, the injected department teardown), and
`apps/server/src/rest/home-vm-purge.test.ts` (a bot purge destroys no VM; a
department delete destroys the department's). The real-VM behaviour
(colocation inside one microVM, per-bot prepare isolation with ownership,
mode-700 homes, hidepid=2, `/tmp` under umask 077, idempotent `useradd`
keeping the same uid, retirement, and ownership + hidepid surviving a VM
restart) was verified with throwaway probe VMs, not in the suite.

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
departments) extends. The host capability (`bash_host` and other tools that
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
  the data folder from backup (`var/`, plus `AUTH_DIR` if the passcode
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

## The host shell's "Always allow"

`bash_host` runs a script directly on the computer the server runs on, so a
whole-tool or wildcard rule for it is never saved from a card. Its card
offers **Always allow this exact command on this computer** instead:

- The rule is stored in the bot's existing allow list
  (`policies.autoApprove`) as `bash_host:=<script>`.
- It matches a later call only when the call's input is exactly
  `{ script }` and the script is the identical string. No globs (a `*` in
  the stored script is literal), no prefixes, no trimming, no other fields.
  A different script, even one extra space, gets a card as before.
- An exact match is approved even if the script looks destructive: the
  owner approved that very text. Glob (`tool:pattern`) rules keep their
  destructive check.
- The same script can behave differently in a different working directory
  (bash_host keeps its directory between calls); the rule is about the
  text, as asked.
- Scripts longer than 2,000 characters, empty scripts and calls with any
  other input shape aren't saved; the call stays gated and the decision
  still goes through.
- The rule shows in the bot's **Access** tab by its script, and the ✕ on it
  removes it (a policies patch); the next call of that script asks again.
- Jev never decides `bash_host` (`JEV_NEVER_DECIDES`) and fully automatic
  (yolo) mode is unchanged. Old `bash_host:<glob>` entries stay inert.
- When a card's input was edited before approving, the rule covers the
  edited input that actually ran, not the original proposal.

Tests: `packages/mind/src/exact-allow.test.ts`, the exact-rule case in
`packages/mind/src/jev-gate.test.ts`, and
`apps/server/src/rest/bash-host-always.test.ts` (server saves the rule over
REST, same script runs without a card, other scripts still ask, removing it
brings the card back).
