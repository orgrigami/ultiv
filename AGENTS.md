# AGENTS.md — spriessen

Effect-first, AI-native web app as a pnpm-workspace monorepo. The **core is three packages**: `@spriessen/core` (kernel: shared tagged errors + the `openRuntime` promise↔Effect door), `@spriessen/ext` (the extension platform: tools, connectors, plugins, registry, vault), and `@spriessen/mind` (the entity substrate — **one runtime, one entity per profile**; user-defined profiles are the entities, a fresh install seeds none and the first bot created becomes the main bot; the package keeps its working name `mind`). `apps/server` (Node 26) is a thin chord host over the mind; `apps/web` (React 19 + TanStack Router + shadcn on Base UI + Tailwind 4) is the thin client over replicated chord state; `packages/contracts` holds the chord contracts (JSON Schema built with pi-schema) shared by both.

This file is the rulebook for working in the repo. The detail lives in `docs/`:

| Read                                                                               | For                                                                                               |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                                       | where everything lives, package by package (core, ext, mind faculties, server routes, CLI, agent) |
| [docs/FEATURES.md](docs/FEATURES.md)                                               | each feature's rule and the files that keep it (tasks, approvals, deadlines, branching, evals, …) |
| [docs/WEB.md](docs/WEB.md)                                                         | the web client: routes, components, styling tokens, the tool-call lens, file previews             |
| [docs/PROVIDERS.md](docs/PROVIDERS.md)                                             | models.dev catalog, provider wiring, efforts, compaction, Jev                                     |
| [docs/NAMING.md](docs/NAMING.md)                                                   | Spriessen vs. the kept `ultiv` names, departments → teams, and what must never be renamed         |
| [docs/SECURITY.md](docs/SECURITY.md), [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) | owner scoping, path confinement, VM isolation, nodes, tokens; what isolation claims               |
| [docs/MEMORY.md](docs/MEMORY.md)                                                   | memory v3: tiers, recall, guard, consolidation, tidy, purge                                       |
| [docs/ROUTINES.md](docs/ROUTINES.md)                                               | cron, webhooks, sensors, receipts, trials, quiet check-ins                                        |
| [docs/SKILLS.md](docs/SKILLS.md)                                                   | the per-bot skill library                                                                         |
| [docs/BOT-FILES.md](docs/BOT-FILES.md)                                             | Persona/Instructions, the bot's file tree and versions, the code tools                            |
| [docs/LIVE.md](docs/LIVE.md)                                                       | the `/push` live-signal socket (no polling)                                                       |
| [docs/CLI.md](docs/CLI.md)                                                         | the `spriessen` command, TUI, serve/daemon/node                                                   |
| [docs/CAPACITY.md](docs/CAPACITY.md)                                               | measured VM footprint and boot times                                                              |
| `apps/web/DESIGN.md`, `apps/web/PRODUCT.md`, `docs/design/`                        | visual authority, product truth, brand voice, design notes                                        |

Keep them true: a change that moves behaviour updates the doc that describes it in the same commit (and the in-app skill, below).

## Toolkit: Vite+ (`vp`) only

**Every command goes through `vp`. Never run `npm`, `npx`, `pnpm`, `yarn`, bare `node`, `tsc`, `vite`, `vitest`, `oxlint`, or `oxfmt` directly.** vp owns the whole chain:

| Need                        | Use                                                                            | Never                                   |
| --------------------------- | ------------------------------------------------------------------------------ | --------------------------------------- |
| Install / sync deps         | `vp install` (`--frozen-lockfile` in CI)                                       | `npm i`, `pnpm i`                       |
| Add / remove a dep          | `vp add <pkg> --filter <workspace>` (`-D` dev, `-E` exact), `vp remove`        | `npm install`, `pnpm add`               |
| Inspect deps                | `vp outdated`, `vp why`, `vp list`, `vp info`                                  | `npm ls`, `pnpm why`                    |
| Run a package script        | `vp run <task>` / `vpr <task>`; one workspace: `vp run --filter <name> <task>` | `npm run`, `pnpm --filter`              |
| Local binary                | `vp exec <bin>` (in a workspace: `vp -C <dir> exec <bin>`)                     | `npx`, `pnpm exec`                      |
| One-off package binary      | `vp dlx <pkg>`                                                                 | `npx <pkg>`                             |
| Node / a TS file            | `vp node <args>`; `vpx <file.ts>`                                              | `node`                                  |
| Format + lint               | `vp check` (`--fix`), `vp fmt`, `vp lint`                                      | `oxfmt`, `oxlint`, `eslint`, `prettier` |
| Tests                       | `vp test`                                                                      | `vitest`                                |
| Dev / build / preview       | `vp -C apps/web dev` / `build` / `preview`                                     | `vite`                                  |
| Anything else pnpm-specific | `vp pm <command>` (forwards to pnpm)                                           | bare `pnpm`                             |

- Vite+ 1.5.0 (global install + `vite-plus` devDep via the pnpm catalog, with the `vite` alias to `@voidzero-dev/vite-plus-core` at the same version). Must stay ≥ 1.1.0: 1.0.0 has known advisories (fixed 1.1.0/1.3.0). Upgrade with `vp upgrade`; inspect with `vp toolchain`.
- Node 26 LTS, LOCKED: `.node-version` (`26`, what `vp` resolves first), `mise.toml` (`node = "26"`), `engines.node: ^26.0.0` in every manifest with `engineStrict: true` in `pnpm-workspace.yaml` (installing on another Node fails), `scripts/install-cli.sh` refuses a non-26 Node, and the server (`start.ts`), the CLI launcher and the node agent refuse an older Node at boot (`nodeVersionProblem` in `@spriessen/core`; a newer line only warns). `GET /api/server/check` reports the server's `node`; `spriessen doctor` checks both ends. Moving to a new line means bumping all of these together. A bare `node`/`npm` on PATH may come from homebrew — never trust it. If `vp` itself isn't on PATH, prepend `~/.vite-plus/bin`. The dev server keeps its pre-bump runtime until restarted in the tmux session.
- pnpm 12 is the package manager underneath (`packageManager` field), but you only ever reach it through `vp`.
- Root `package.json` scripts (`check`, `build`, `test`, `smoke`) run with `vpr <name>`. `vp check` (built-in) and `vpr check` (script) do the same thing here.

## Commands (verified)

- `vp check` — format + lint gate (`--fix` to apply). It does NOT run our project typechecks.
- `vp exec tsc -p <pkg>/tsconfig.json` — the type gate, for each of `packages/contracts`, `packages/core`, `packages/ext`, `packages/mind`, `packages/about`, `packages/present`, `apps/server`, `apps/web`, `apps/agent`, `apps/cli`. All ten must pass.
- `vp test` — Vitest from the root over every workspace's tests (`packages/about`, `packages/contracts`, `packages/core`, `packages/ext`, `packages/mind`, `apps/server`, `apps/web`, `apps/agent`, `apps/cli` — the CLI's TUI tests render headless through OpenTUI's test renderer; one package: `vp run --filter @spriessen/core test` — `apps/web` has no `test` script, so filter by path there: `vp test apps/web`).
- `vp -C apps/web build` — production build of `apps/web` (root `vp build` needs the `-C` target; `vpr build` wraps this and the CLI build).
- `vp -C apps/cli build` — the `spriessen` command's bundle (`apps/cli/dist`, every package import external): plain Node then runs the TSX terminal UI through `apps/cli/bin/spriessen.mjs`. Without it, `vp node apps/cli/src/main.ts …` runs every command except the UI, and `vpx apps/cli/src/main.ts` runs the UI from source. Docs: `docs/CLI.md`.
- `scripts/install.sh` — the one-line `curl … | sh` installer: clones (or fast-forwards) the source into `~/.spriessen/sources`, creates `~/.spriessen/.env` (0600, fresh `VAULT_KEY`) once, then runs install-cli.sh. `spriessen update` / `spriessen data [move]` are the CLI's own update and data commands.
- `sh scripts/install-cli.sh` — installs the `spriessen` command from this checkout (dependencies, both builds, a launcher in `~/.local/bin` pinned to the Node `vp node` resolves; `--prefix`, `--uninstall`). A shell script on purpose: `vp node` cannot run inside a nested `vp run`.
- `vp run smoke` — boots the whole server stack on an ephemeral port, offline (`apps/server/src/smoke.ts`; delegates to the server workspace script because `vp node` cannot resolve node inside a nested `vp run`), and exercises the REST surface: owner-scoped sessions, artifact upload/download, webhook auth, cron validation, task spawn.
- `vp install --frozen-lockfile` — verifies the lockfile is in sync and passes supply-chain policy.
- `vp -C apps/web exec shadcn <cmd>` — shadcn CLI (e.g. `add <component>`), run where `components.json` lives.

Not run automatically (long-running or live):

- `vp node --env-file=.env packages/mind/src/probe.ts` — LIVE provider check (network + keys): converse on the default model through the harness, Jev via the `jev_score` tool, Jev `decide` direct, plus `now` and `web_search` through the act.
- `vp run --filter @spriessen/server dev` — server with watch + `--env-file`; listens on `PORT` (default 8787).
- `vp -C apps/web dev` — web dev server.
- `vpr @spriessen/server#push:keys` — one-time VAPID key generation: appends `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` to `.env` only when absent, prints no value. Never rotate casually (every device must re-subscribe).

**Every facet reaches the app:** the server binds all interfaces IPv4+IPv6 when `HOST` is unset (`apps/server/src/listen.ts` logs one URL per facet on boot); `vp dev` and `vp preview` accept any Host name (`ALLOWED_HOSTS` narrows) and proxy `/api`, `/hooks` and `/chord` to `API_URL` (default `http://127.0.0.1:$PORT`), and the client always talks same-origin (`/chord` for the socket). So localhost, 127.0.0.1, `[::1]`, the LAN, a tailnet IP / MagicDNS name / `tailscale serve` HTTPS, or any other name that routes here all work without config.

**The owner's live dev server runs in tmux session `ultiv`** (API on 8787 under `node --watch`, Vite on 5173; the tailnet serves them as `https://<mac>.ts.net` and `:8443`). Do NOT restart it: `--watch` already reloads on source and `.env` changes. Only if it errors or a dependency change forces it, restart it yourself in that tmux session and read its log. Smoke tests and screenshot stacks use a spare random port, never 8787/5173.

**Gate for every change:** `vp check` → the ten `vp exec tsc -p …` → `vp test` → `vp -C apps/web build` → `vp -C apps/cli build` → `vp run smoke`. Re-run smoke after any dependency change; a clean typecheck alone does not prove runtime ESM wiring.

## Layout (short; full map in docs/ARCHITECTURE.md)

| Workspace                                     | What it is                                                                                                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core` (`@spriessen/core`)           | the kernel: the home and data folder (`dataPath`), tagged errors, `openRuntime`, `resolveInside`, `ownerErrorText`, Node version check. Deps: `effect` only |
| `packages/ext` (`@spriessen/ext`)             | the extension platform: tools, connectors, plugins, registry, vault, credential broker, the shell, each bot's file tree (`fs/`), code intel                 |
| `packages/mind` (`@spriessen/mind`)           | the entity substrate: converse, decide, act, generate, tasks, profiles, rooms/mailbox, memory, search, history, skills, projects, evals, routines, audit    |
| `packages/contracts` (`@spriessen/contracts`) | JSON Schema contracts (pi-schema builders; chord + REST payloads) shared by server, web and CLI                                                             |
| `packages/present` (`@spriessen/present`)     | owner-facing words both clients share (tool-call lens, approval words, file kinds)                                                                          |
| `packages/about` (`@spriessen/about`)         | the built-in `spriessen` skill every bot gets                                                                                                               |
| `apps/server`                                 | Node 26 host: chord Session, REST (`rest/`), triggers (cron, webhooks, sensors), push, auth                                                                 |
| `apps/web`                                    | React 19 + TanStack Router + shadcn on Base UI + Tailwind 4 client (docs/WEB.md)                                                                            |
| `apps/cli`                                    | the `spriessen` command: line commands, the OpenTUI terminal UI, serve/daemon/node (docs/CLI.md)                                                            |
| `apps/agent`                                  | the node agent behind bash's `node` target                                                                                                                  |

## Rules that cut across features

- **The mind is the only provider consumer.** Every model call goes through a pi-durable conversation in `@spriessen/mind` (`converse.turn` = submit → wait → commit); `generate` is the one sanctioned non-conversational path and lives inside the mind. Never raw `models.complete()` in app code, and never `response_format: json_object` (it hangs some gateways): ask for strict JSON in the prompt. Models are `provider/model`, split at the first slash. Details: docs/PROVIDERS.md.
- **`.env` holds provider keys, server-side only.** Never commit, print or ship it to the client; load it with `vp node --env-file=…` (or the `dev`/`start` scripts), never by echoing it.
- **Each profile is its own entity.** Persona, memory, artifacts, vault scope, tool allowlist and audit are per profile. Never describe the platform as "one entity".
- **Chats coordinate, tasks work.** A chat is offered only `CHAT_TOOLS` (`packages/mind/src/profiles/chat-tools.ts`); anything that reads or acts on the world runs in a task. A new chat-safe tool goes on that list; a new work tool does not.
- **A new tool lands with its words.** `apps/web/src/lib/tool-coverage.test.ts` fails when a tool has no presentation in `@spriessen/present` or a gated tool has no approval-card words (`approval-text.ts` `KNOWN`).
- **Change the app, update the in-app skill.** `packages/about/skills/spriessen/` is what every bot knows about the app; `packages/about/src/drift.test.ts` fails on a tool it names that no package defines, a nav place it misses, or a dropped description it brings back.
- **No polling in the client.** Live changes arrive as coarse signals over `/push` and the client refetches over REST (docs/LIVE.md). Do not add replicated chord objects for CRUD (see Pitfalls).
- **Web UI essentials** (the rest in docs/WEB.md): shadcn `base-nova` on Base UI, composed with the **`render` prop, not `asChild`** (a `Button` rendering a `Link` also takes `nativeButton={false}`); add components with `vp -C apps/web exec shadcn add <name>` and reuse the primitives in `src/components/ui/`; Tailwind 4 CSS-first, every token in `src/index.css`, semantic tokens only (no raw colors); `cn()` from the `cn` package; lucide icons; loading states are skeletons; motion ≤ 200 ms and off under reduced motion; plain product vocabulary in copy (Now, Chats, Crew, Settings, Bot talks, Routines, Tools, Vault). The alias `@/*` → `apps/web/src/*` is declared in three places (`apps/web/vite.config.ts`, `apps/web/tsconfig.json`, root `vite.config.ts`); keep them in sync. `src/routeTree.gen.ts` is generated, committed, never hand-edited.
- **Names.** The product is Spriessen; many stored names keep the old `ultiv` spelling on purpose and existing team ids keep `dept-`. Never rename a kept name without a migration: docs/NAMING.md lists them.

## Conventions

- ESM only; tabs (oxfmt via `vp fmt` enforces); `import type` for type-only imports (`verbatimModuleSyntax`).
- Relative imports use explicit `.ts` extensions (`allowImportingTsExtensions` + Node type stripping).
- **Shared versions live in the pnpm catalog** (`catalog:` in `pnpm-workspace.yaml`): every dependency used by two or more workspaces (`effect`, `croner`, the `@earendil-works/*` set, the `@modelcontextprotocol/*` pair) is declared `"catalog:"` in each `package.json` and versioned ONCE in the catalog. Adding one of them to another workspace: write `"catalog:"` in its manifest, then `vp install`. Promote a dependency into the catalog the moment a second workspace needs it.
- The `@earendil-works/*` packages (chord, pi-ai, pi-codemode, pi-durable, pi-schema) are pinned exact and ship in lockstep: bump them together. chord 1.5.0 pins its optional `ws` peer exactly; `peerDependencyRules` allows any ws 8.
- JSON Schema built with `@earendil-works/pi-schema` (`obj`, `str`, `oneOf`, …; `Static` for types, `compile(schema).check/errors` to validate) is the only schema language at the chord boundary and in tool parameters; Effect Schema stays inside effect services. TypeBox is gone (chord 1.5.0 dropped it). pi-schema's `obj()` is CLOSED by default: our contracts and tool schemas pass `{ open: true }` (what TypeBox's `Type.Object` was); share an object's properties as a plain const to extend it (there is no intersect). Third-party schemas (MCP, `result_schema`) compile with `{ formats, unresolvedRefs: "reject" }`, as the harness does; `format` is only checked where `formats` is passed.
- Strict TS: `exactOptionalPropertyTypes` (never assign explicit `undefined` to optional props), `noUncheckedIndexedAccess`.

## Repo rules (set by the owner)

- **vp only** — no `npm`/`npx`/`pnpm`/bare `node` in commands, scripts, docs, or CI. If vp lacks a command, use `vp pm …` and note why.
- MAX 500 LoC per file; MAX 100 LoC per function/component — at 80 LoC, split.
- Code must be linted (`vp check`), typechecked (`vp exec tsc -p …` ×10), and tested (`vp test`) — the gate above is the proof. Never claim code is "tested" without it.
- Work done = work committed: atomic commits, conventional-commit messages (`feat:`, `fix:`, `chore:`, `build:`, `docs:`).

## Pitfalls

- **Never add `vite` or `vitest` as a dependency.** vp owns them via the pnpm catalog (`vite` → `@voidzero-dev/vite-plus-core`); a standalone vite makes `vp build` fail. Run `vp migrate --no-agent` if the alias drifts.
- `BACKGROUND_CONTEXT` is NOT exported from the chord root — import it from `@earendil-works/chord/context`.
- pi-durable's README examples drift from its 1.5.0 types — trust `dist/*.d.ts`: `AssistantEntry` stores the message in `record.model[0]` (`[AssistantMessage]`), `settled.answer` is an `EntryId`, `commit()` may return `undefined`.
- pnpm 12 gates build scripts with `allowBuilds` in `pnpm-workspace.yaml` (not the old `ignoredBuiltDependencies`). `@google/genai` and `protobufjs` are explicit `false` (vetted no-ops) — never flip to `true` without reading the script. To allow one deliberately: `vp add <pkg> --allow-build <pkg>`.
- `vp install` may report "Agent skills awaiting approval" (currently `@tanstack/react-router`, `@tanstack/router-plugin`). vp 1.5.0 does not forward pnpm's `approve` (`vp pm approve` errors; only `approve-builds` exists), so leave them unapproved — approving is the owner's call, not an agent's.
- **Owner data goes through `apps/server/src/rest/owner-scope.ts`.** A new REST route that reads or writes a bot, session or routine checks ownership there and answers another owner's item exactly like a missing one (same 404/empty/`{ ok: false }`). See `docs/SECURITY.md`.
- **Never `join` a caller-supplied id or path onto a data folder.** Use `resolveInside` / `tryResolveInside` from `@spriessen/core` (re-exported by `@spriessen/ext` for the server): it refuses `../`, absolute parts and symlinks out. See `docs/SECURITY.md`.
- **Webhook tokens exist only as hashes.** Rows in `ultiv.webhooks` carry `tokenHash` (`sha256:<hex>`); check with `verifyWebhookToken`, never compare or log a token yourself, and never put a token or hash in a list, tool output or receipt. The token is returned once (create / `rotateWebhookToken`); `sealWebhookTokens` on boot converts legacy plaintext rows (repeatable). Return plain copies from `docs.commit` callbacks: draft values die with the transaction ("Cannot use a settled overlay").
- Files Node executes directly (server, probe, smoke) must be erasable-syntax-only TS: no enums/namespaces/parameter properties.
- Annotate chord `principal` callbacks with the app `Principal` type — inline object literals widen string literals and break `Host<P>` inference.
- `tsconfig.json` files must stay strict JSON (tooling validates them; no comments).
- Effect 4 (the repo's version) drifts from Effect 3 habits: there is NO `Effect.catchAll` (use `Effect.match` / `catchTag` / `catchIf`); `ConfigError` imports from `"effect/Config"`, not the root; `Layer.merge` is binary (chain `.pipe(Layer.merge(…))` or `mergeAll`); `Layer.buildWithScope` yields a `Context` — extract the service with its key; `Config`'s env provider snapshots `process.env` at FIRST use, so tests must set env at module load, never mid-test; `Data.TaggedError` instances yield directly (`return yield* new NotFound(…)`).
- Effect Layers compose services; a parameterized layer is a function returning a Layer. Long-lived runtimes (server, probe) go through `openRuntime(layer, key)` in `@spriessen/core` — never `Effect.scoped` around a service that must outlive the call.
- Structured tool outputs must be JsonValue-compatible: use `type` aliases, not `interface`, for result shapes (interfaces lack implicit index signatures).
- `vp node` cannot resolve node when invoked INSIDE a `vp run` script — root scripts delegate (`vpr smoke` → the server workspace script) instead of nesting `vp node`.
- **A conversation's view is a watch, and windowed** (pi-durable 1.5.0 removed `viewState()`): read it once with `readView(conversation, window?)` from `@spriessen/mind`, follow it with `conversation.watch(ctx, window)` + `start(({ kind, value }) => …)` and `stop()`. `entries` is a window (default the newest 50); transcript projections pass `TRANSCRIPT_WINDOW`. Restart-limited turns end with `pi.live.runFailure` instead of parking; Needs you lists them from `task_interrupted` reports (`converse/control.ts`) and Retry submits a `continue`.
- chord 1.4.0's replicated-object attach desynced over the wire (not re-measured on 1.5.0): attaching an object whose state carries data (or publishes during attach) trips `ChordError: invalid/protocol: ack N outside 0..N`, after which the link drops publications. It logs on every Session attach — delivery still works (the task's publications resync), but do NOT add more replicated CRUD objects over the wire: the session registry is REST for exactly this reason.
