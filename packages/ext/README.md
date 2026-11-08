# @spriessen/ext

The extension platform: the standard future development plugs into. The full
file-by-file map is in `docs/ARCHITECTURE.md`.

- `tool.ts` — the one tool surface (pi-durable's `ToolRegistration` shape plus a
  `gated` flag for side-effecting tools; the approval broker wraps those at the
  act, never reads). pi-durable is a **type-only** dependency here — no runtime
  import — so tools stay harness-shaped without coupling the registry to it.
- `connector.ts` — the connector standard: identity, auth (`none | env |
  vault`), and TypeBox-typed actions with Effect `perform`s, invoked through
  `invoke` (validate -> authenticate -> perform).
- `plugin.ts` — the unit of extension: a named, versioned bundle of
  capabilities (`tool`, `connector`, `section`; new kinds extend the union).
- `registry.ts` — the `Registry` service: install plugins, resolve capabilities,
  reject duplicate identities.
- `vault.ts` — the credential vault: per-item AES-256-GCM under a
  `VAULT_KEY`-derived key, masked metadata; no tool ever returns secret bytes.
- `broker/` — the credential broker behind `http_request`: spends a sealed
  secret only inside its binding, with an SSRF/DNS guard and scrubbed
  responses.
- `fs/` — each bot's ONE file tree (`DurableFs`, `putFile`, hidden versions of
  overwritten files, adoption of files from before the tree); see
  `docs/BOT-FILES.md`.
- `shell/` + `plugins/bash*.ts` — the `bash` tool: a microsandbox microVM per
  home by default, `host` and `node` targets, background jobs.
- `plugins/` — the built-in tools: artifacts, files and code intel, the web
  (`tinyfish.ts`, `browser.ts`), `graph`, calendar, feeds, email, vault
  metadata, and `http.ts`, the reference connector (generic HTTP egress).
- `mcp/` — MCP clients (HTTP, SSE, stdio) the mind installs per server.
- `docs/` — text extraction from PDF and Word files.

Lifecycle is Effect layering, not plugin callbacks: a plugin is declarative
data; composition and teardown belong to the Layers that install it.
