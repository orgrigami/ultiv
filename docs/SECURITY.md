# Security notes

How the server keeps files, owners and webhook tokens apart. Each section
names the one helper that enforces it, so a later change has one place to edit.

## File paths stay inside their folder

Every store that turns a request or tool argument into a file path goes
through `resolveInside(root, ...parts)` from `@spreissen/core`
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

Tests: `packages/core/src/safe-path.test.ts`,
`packages/ext/src/path-confinement.test.ts`,
`packages/mind/src/skills/confinement.test.ts`, and the
"artifact routes stay inside the artifacts folder" block in
`apps/server/src/rest/artifacts.test.ts`.

## Owner scoping

There's no sign-in yet: the owner label is the `x-spreissen-user` header
(`x-ultiv-user` still accepted), and a request without one is `guest`, which is
how the web app runs single-user. Every REST route that reads or changes owner
data asks one helper, `apps/server/src/rest/owner-scope.ts`
(`ownsProfile`, `ownsSession`, `ownedTarget`, `ownsRecord`, `ownedRecords`,
`findOwned`).
When a real sign-in arrives, only the source of `args.owner`
(`apps/server/src/identity.ts`) changes; the checks stay.

Another owner's item is answered exactly like a missing one (a 404 with the
same body, an empty list, or `{ ok: false }`), so ids can't be probed.

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

Tests: `apps/server/src/rest/owner-scope.test.ts` (owner-a / owner-b over the
real REST handler, plus a no-header guest run) and the owner check in
`vp run smoke`.

## Webhook tokens are stored as hashes

A webhook URL is `/hooks/<id>?token=<token>` (or the token in an
`x-spreissen-token` header; `x-ultiv-token` is still read). The token is the
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
