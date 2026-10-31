# Security notes

How the server keeps files, owners, webhook tokens and the host shell apart. Each section
names the one helper that enforces it, so a later change has one place to edit.

## Sign-in (passcode and sessions)

Until a passcode is set, the only thing anyone can do is the one-time
"set passcode" step, and only from an unproxied loopback request (setting
the first passcode happens at the machine; it signs that browser in). The
rest of the API and every socket answer the sign-in refusal, loopback
included. A
proxied request — tailscale serve, any reverse proxy — is never loopback
(`x-forwarded-*` present), so the LAN and the tailnet get the
sign-in-required answer from the start. After a passcode exists, every
request needs a session, loopback included.

- The gate is one function, `authorize` in `apps/server/src/auth/guard.ts`,
  and it runs before any route: one refusal shape (`401 {"error": "sign in
  required"}`) for everything, so a probe learns nothing per route.
- The passcode is stored only as a slow hash: scrypt (N=16384, r=8, p=1)
  with a random salt, in `AUTH_DIR/auth.json` (default `var/auth`, 0600).
  Nothing else about it is stored; a wrong passcode never names which part
  was wrong.
- Sign-in is throttled: the first wrong attempts answer at once; from the
  fifth, each attempt locks for a doubling wait capped at 15 minutes. The
  right passcode during a lock is refused like any other (`429`, with
  `Retry-After`).
- A signed-in session is a random 32-byte id in an HttpOnly, SameSite=Strict
  cookie (`spriessen_session`), Secure when the request came over HTTPS.
  Sessions expire after 30 idle days (sliding: use refreshes), live in
  `AUTH_DIR/sessions.json`, and are capped at 100 (the oldest falls out).
- As a second fence against cross-site requests (CORS stays `*` by
  decision): state-changing `/api` requests never arrive as a cross-site
  form — the form content types (`application/x-www-form-urlencoded`,
  `multipart/form-data`, `text/plain`) are refused with 415. JSON and
  bodyless posts pass; raw-byte artifact uploads are exempt.
- Routes that answer without a session: `GET /api/health`, the webhook
  ingress `POST /hooks/:id` (its token is the auth), and `/api/auth/*`
  (status, sign-in, sign-out, setup, change). The first-time setup
  additionally requires the unproxied loopback.
- Changing the passcode needs the current one; sessions survive a change.
  **Passkeys** work beside the passcode (WebAuthn, via
  `@simplewebauthn/server`): a signed-in owner adds one in Settings, and the
  sign-in screen offers "Use a passkey" whenever one exists for the site's
  origin. The rp id and origin come from the request's own Host, so
  localhost and the tailnet HTTPS facet each register their own working
  passkey. The passcode stays as the fallback and cannot be removed.
  Forgotten passcodes: the recovery command (see README) resets the passcode
  and clears every session from the host.

Tests: `apps/server/src/auth/auth.test.ts`, `store.test.ts`, and
`passkeys.test.ts` (wiring; the browser round-trip was verified in Chrome
with a CDP virtual authenticator: register, sign out, sign in).

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
without one is refused at the handshake.

### Migration of pre-sign-in data

Older installs stored rows under whatever label the old header carried
(`guest`, mostly). On every boot, before the server listens,
`migrateOwners` (`packages/mind/src/migrate/owners.ts`) moves every row,
main-bot entry, task, room and mailbox record with such a label to
`owner`, re-aliases each session's durable conversation key (a new
`ultiv.session-map` entry pointing at the SAME conversation, so no
transcript is orphaned), and copies each v2 memory family's content to the
account's family keys. On disk, the per-owner folders (artifacts, skills,
bot files, MCP work dirs, vault) and the artifact sidecars' owner fields
move with them (`apps/server/src/auth/migrate-storage.ts`). Rows stamped
`agent` (bot-spawned task sentinel) never move. It is repeatable and logs
a count when anything moved.

- **Dry run:** `vpr @spriessen/server#owners:dry-run` (server stopped)
  prints what a boot would move, changing nothing.
- **Rollback:** rows keep nothing of the old label behind, but the old
  conversation keys, memory family keys and push subscriptions stay in
  place untouched; the folder move is a rename. Rolling the CODE back
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
the real REST handler), `packages/mind/src/migrate/owners.test.ts` (cross-label
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
