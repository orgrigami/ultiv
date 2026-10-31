# @spreissen/mind

The entity substrate: **one runtime, and each profile (bot) is its own entity**
with its own persona, memory, artifacts, vault scope, tool allowlist and
audit trail. A fresh install has no profiles; the first bot created becomes
the main bot (the package keeps its working name, `mind`). AI is native infrastructure here, not a feature bolted on:
chat is only one of an entity's forms, and every LLM/decision call goes
through this package.

Faculties every entity shares (scoped per profile through the
conversation→profile index):

- `converse` — durable conversations over the pi-durable harness
  (`root`/`ensure`/`turn`: submit -> wait -> commit is the only path an input
  reaches a model), plus `docs` (app-level durable documents) and the transcript
  projection every surface renders through. **Redirect now**
  (`converse/redirect.ts`) is the owner's explicit interrupt: it stops the
  running turn at the nearest safe point (streaming: abort now; a tool round:
  let it finish within `REDIRECT_TOOL_GRACE_MS`, 15 s; a waiting approval:
  deny it) and answers the new message; queued messages stay queued.
- `decide` — typed decisions through Jev, **independent of chat**: `yesNo`,
  `pick`, `rate`, `ask` work with zero conversation infrastructure. The same
  faculty also appears as native agent tools (`jev`, `jev_score`, `jev_pick`,
  `jev_rate`) via the extension registry — one capability, two faces.
- `act` — the executable tool surface, assembled from `@spreissen/ext` plugins;
  `gated` tools pass through the approval broker at the act. The identity
  section ("You are <bot>…", persona + sibling roster) renders into every
  system prompt — models have no self-knowledge; undeclared, they answer from
  training priors.
- **Credential broker** (`act/broker.ts` over `@spreissen/ext` `broker/`) — the
  `http_request` tool spends a sealed vault secret without the model ever
  seeing it: the item's binding (hosts, methods, path prefixes, placement,
  bots) is checked BEFORE the secret opens, https only (localhost http per
  binding), an SSRF/DNS guard refuses private and metadata addresses,
  auth drops on cross-host or off-prefix redirects, responses are scrubbed of
  the secret (raw/hex/base64 forms), and every use is audited (kind
  `credential`, never the secret). A credential's first use on a host raises
  its own approval card that "Always allow" never covers. HTTP is the first
  adapter; others implement the same `CredentialAdapterImpl` shape.
- `tasks` — background sub-agent turns in their own conversations. The
  parent bot steers a running task with `task_message` (arrives as
  `[from parent]`); a long task posts rare progress lines to its owner with
  `notify_owner` (one per 2 min, 280 chars); at most
  `SPREISSEN_MAX_RUNNING_TASKS` (3) run per bot. The web shows them as the task
  pill above the composer. `tasks.listen` hears each task settle.
- `mailbox` — bot-to-bot messages through contextual rooms. Each request has
  a deadline, `MAILBOX_DEADLINE_MS` (default 15 minutes); an unanswered one
  expires and NACKs the sender. `mailbox.onExpired` hears it.
- `approvals` — the gate broker; `approvals.listen` hears every card that
  actually waits on the owner (auto-approved calls never fire).
- `mcp` — MCP connectors (HTTP, SSE, stdio) installed live per server, each
  bot reaching them through `connector_load`. Bots manage them with the
  `connector_*` tools; every change parks on a never-auto-approved card
  showing the exact change (`mcp/manage*.ts`, presets in `mcp/presets.ts`).
- `secrets` — `secret_request`: a masked field in the chat that stores a key
  straight into the vault (`POST /api/secrets/:callId`); the value never
  passes through the model, transcript, audit or logs.
- Bot discovery — `bots_list` / `bot_info` (`profiles/bots*.ts`): siblings'
  public facts only (role, persona's first line, contact rights, tool
  groups, busy/idle). The prompt roster stays one capped line per sibling.
- `generate`, `memory`, `audit`, `profiles`, `schedules`, `sensors`, `state`.

The three listeners (`tasks.listen`, `approvals.listen`,
`mailbox.onExpired`) are how the server's Web Push notifier learns what to
tell the owner; payloads never carry tool input, results or message text.

Owner rule: nothing here may call a raw provider completion in app code — all
generation rides the harness. Enter with `openMind()` (the promise-land door);
Effect-native composition goes through `mindLayer`.
