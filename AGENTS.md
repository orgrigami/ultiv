# AGENTS.md — spriessen

Effect-first, AI-native web app as a pnpm-workspace monorepo. The core is three packages: `@spriessen/core` (kernel: tagged errors, `openRuntime`, the one home folder), `@spriessen/ext` (extension platform: tools, connectors, plugins, registry, vault) and `@spriessen/mind` (the entity substrate: **one runtime, one entity per profile**; a fresh install seeds no profile and the first bot created becomes the main bot). `apps/server` (Node 26) is a thin chord host over the mind, `apps/web` (React 19 + TanStack Router + shadcn on Base UI + Tailwind 4) a thin client over it, `apps/cli` the `spriessen` terminal client, `apps/agent` the node agent, `packages/contracts` the shared schemas.

**Where things are and the contract each feature keeps: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).** Read the section for the area you touch before changing it, and update it in the same commit. Deeper contracts: `docs/MEMORY.md`, `docs/ROUTINES.md`, `docs/SKILLS.md`, `docs/LIVE.md`, `docs/SECURITY.md` (+ `THREAT_MODEL.md`), `docs/BOT-FILES.md`, `docs/CLI.md`, `docs/CAPACITY.md`; design authority `apps/web/DESIGN.md`, product truth `apps/web/PRODUCT.md`, voice `docs/design/brand.md`.

## Toolkit: Vite+ (`vp`) only

**Every command goes through `vp`. Never run `npm`, `npx`, `pnpm`, `yarn`, bare `node`, `tsc`, `vite`, `vitest`, `oxlint`, or `oxfmt` directly.**

| Need                        | Use                                                                            | Never                                   |
| --------------------------- | ------------------------------------------------------------------------------ | --------------------------------------- |
| Install / sync deps         | `vp install` (`--frozen-lockfile` in CI)                                       | `npm i`, `pnpm i`                       |
| Add / remove a dep          | `vp add <pkg> --filter <workspace>` (`-D` dev, `-E` exact), `vp remove`        | `npm install`, `pnpm add`               |
| Update in range             | `vp update -r <pkg…>`; inspect with `vp outdated -r`, `vp why`, `vp info`      | `npm update`, `pnpm why`                |
| Run a package script        | `vp run <task>` / `vpr <task>`; one workspace: `vp run --filter <name> <task>` | `npm run`, `pnpm --filter`              |
| Local binary                | `vp exec <bin>` (in a workspace: `vp -C <dir> exec <bin>`)                     | `npx`, `pnpm exec`                      |
| One-off package binary      | `vp dlx <pkg>`                                                                 | `npx <pkg>`                             |
| Node / a TS file            | `vp node <args>`; `vpx <file.ts>`                                              | `node`                                  |
| Format + lint               | `vp check` (`--fix`), `vp fmt`, `vp lint`                                      | `oxfmt`, `oxlint`, `eslint`, `prettier` |
| Tests                       | `vp test`                                                                      | `vitest`                                |
| Dev / build / preview       | `vp -C apps/web dev` / `build` / `preview`                                     | `vite`                                  |
| Anything else pnpm-specific | `vp pm <command>` (forwards to pnpm)                                           | bare `pnpm`                             |

- Vite+ 1.5.0 is the repo's toolchain (the `vite-plus` devDep via the pnpm catalog; `vp --version` shows it under "Local vite-plus"). Keep it ≥ 1.1.0 (1.0.0 has advisories). Upgrade the global CLI with `vp upgrade`.
- Node 26 LTS, pinned in `mise.toml`; `vp node --version` resolves the same 26.x. A bare `node`/`npm` on PATH may be homebrew's — never trust it. If `vp` is not on PATH, prepend `~/.vite-plus/bin`.
- pnpm 12 underneath (`packageManager`), reached only through `vp`. Root scripts (`check`, `build`, `test`, `smoke`) run with `vpr <name>`.

## Commands and the gate

**Gate for every change, in order:** `vp check` → the ten typechecks → `vp test` → `vp -C apps/web build` → `vp -C apps/cli build` → `vp run smoke`. Re-run smoke after any dependency change; a clean typecheck does not prove runtime ESM wiring.

- `vp check` — format + lint (`--fix` applies). It does NOT typecheck.
- `vp exec tsc -p <pkg>/tsconfig.json` for each of `packages/contracts`, `packages/core`, `packages/ext`, `packages/mind`, `packages/about`, `packages/present`, `apps/server`, `apps/web`, `apps/agent`, `apps/cli` — all ten must pass.
- `vp test` — Vitest over every workspace from the root. One package: `vp run --filter @spriessen/core test`; `apps/web` has no `test` script, so `vp test apps/web`. The real-microVM suite (`packages/ext/src/shell/real-vm.test.ts`) skips unless enabled.
- `vp -C apps/web build`, `vp -C apps/cli build` (`apps/cli/dist`; without it `vp node apps/cli/src/main.ts …` runs every command but the UI, `vpx apps/cli/src/main.ts` runs the UI from source).
- `vp run smoke` — boots the whole server offline on an ephemeral port and exercises the REST surface (`apps/server/src/smoke.ts`).
- `vp install --frozen-lockfile` — lockfile in sync and passing the supply-chain policy (minimum release age; never add a `minimumReleaseAgeExclude` to get a fresh version in — pick an older one).
- `vp -C apps/web exec shadcn <cmd>` — the shadcn CLI, where `components.json` lives.
- Install paths: `scripts/install.sh` (the `curl … | sh` installer into `~/.spriessen`), `sh scripts/install-cli.sh` (the `spriessen` command from this checkout; a shell script because `vp node` cannot run inside a nested `vp run`). `spriessen update` / `spriessen data [move]` are the CLI's own.

Not run automatically: `vp node --env-file=.env packages/mind/src/probe.ts` (LIVE provider check, network + keys), `vp run --filter @spriessen/server dev` (server, watch + `--env-file`, `PORT` default 8787), `vp -C apps/web dev`, `vpr @spriessen/server#push:keys` (one-time VAPID keys; never rotate casually — every device must re-subscribe).

**The owner's live dev server runs in tmux session `ultiv`** (API 8787 under `node --watch`, Vite 5173; the tailnet serves them as `https://<mac>.ts.net` and `:8443`). Do NOT restart it: `--watch` reloads on source and `.env` changes. Only if it errors or a dependency change forces it, restart it yourself in that session and read its log. Smoke tests and screenshot stacks use a spare random port, never 8787/5173.

**Every facet reaches the app:** with `HOST` unset the server binds all interfaces; `vp dev`/`vp preview` accept any Host (`ALLOWED_HOSTS` narrows) and proxy `/api`, `/hooks`, `/chord`, `/push` same-origin to `API_URL` (default `http://127.0.0.1:$PORT`). localhost, LAN, tailnet names and `tailscale serve` all work without config.

## Naming

The product is Spriessen (`@spriessen/*`, `SPRIESSEN_*` env keys, the `x-spriessen-token` webhook header). The short-lived misspelling Spreissen is a clean cut: `SPREISSEN_*` / `x-spreissen-*` are not read; only saved state carries over (`spreissen.*` browser keys via `apps/web/src/lib/stored-key.ts`, the `spreissen` skill switch via `RENAMED_BUILTINS` in `packages/mind/src/skills/store.ts`). **Kept on purpose with the old `ultiv` spelling — never rename without a migration:** stored record names (`ultiv.sessions`, `ultiv.mem.*`, `ultiv.kv.<profile>`, …), chord remote and tool/plugin ids (`ultiv.session`, `ultiv.bash`, …), the vault key salt, the sandbox image tag and VM names (`ultiv-sandbox:latest`, `ultiv-<hash>`), the deprecated `ULTIV_*` env fallback (`readEnv`), the legacy `x-ultiv-token` header, the GitHub repo (`orgrigami/ultiv`), the local folder and the tmux session.

## Map (detail in docs/ARCHITECTURE.md)

- `packages/core` — kernel, no domain knowledge, deps `effect` only: `home.ts` (the ONE home, `$SPRIESSEN_HOME` or `~/.spriessen`; `dataPath()` is the default of every data env key — never hardcode `var/`), `errors.ts`, `error-text.ts` (`ownerErrorText`), `runtime.ts` (`openRuntime`), path confinement (`resolveInside`).
- `packages/ext` — tools, connectors, plugins, registry, the credential vault and broker, the artifact/file/code-intel/graph plugins, MCP transport.
- `packages/mind` — the faculties: converse (pi-durable harness), decide (Jev), act (tools + approval broker + audit), generate, tasks, profiles/rooms, mailbox, memory (`docs/MEMORY.md`), search, history, skills, routines, checklist; composed in `entity.ts` (`openMind`).
- `packages/contracts` — TypeBox schemas: chord contracts (`Session`, `Ping`) and every REST payload.
- `packages/about` — the app's self-knowledge as built-in Agent Skills. **Change the app, update the skill in the same commit**; `src/drift.test.ts` fails on tools, nav labels or dropped descriptions the prose gets wrong.
- `packages/present` — owner-facing words both clients share (tool-call lens, approval-card words), imported by subpath.
- `apps/server` — `buildStack()` in `main.ts`, REST in `rest.ts` + `rest/`, the chord `Session` in `session.ts`, sign-in in `auth/`, identity seam in `identity.ts`, triggers in `deliver.ts`/`webhooks.ts`/`cron.ts`/`sensors.ts`, push in `push/`.
- `apps/web` — routes in `src/routes/` (file-based), components in `src/components/` (primitives in `ui/`), state in `src/lib/`.
- `apps/cli`, `apps/agent` — the terminal client and the node agent (`docs/CLI.md`, `docs/SECURITY.md` "Paired nodes").

## Rules by area

**The mind and AI providers**

- The mind is the only provider consumer: every chat goes through pi-durable conversations (`converse.turn` = submit → wait → commit). `generate` is the one sanctioned non-conversational exception, and it lives inside the mind. Never call `models.complete()` from app code.
- Models are `provider/model`, split at the FIRST slash. The catalog is models.dev per configured provider (`packages/mind/src/providers/`). Usage reaching contracts/UI is TOKENS only.
- **Never use `response_format: json_object`** — it hangs some gateways (kenari); ask for strict JSON in the prompt. Kenari misreports its model id; routing follows the requested id.
- `model: null` means the workspace default, never "no model" (`converse/selection.ts`).
- The model Gate (`providers/gate.ts`) wraps stream CONSUMPTION — never wrap the stream call itself in a Promise; the harness iterates it synchronously.
- Jev (`@typesafe-ai/sdk`) is a decision faculty behind the `JevGateway` seam, never a chat provider; unconfigured keys fail loudly but lazily.
- `.env` holds provider keys, server-side only: never commit, print or ship them; load with `vp node --env-file=…`.
- Each profile is its own entity (persona, memory, artifacts, vault scope, allowlist, audit). Never describe the platform as "one entity".

**The web client**

- shadcn style `base-nova` on Base UI (`@base-ui/react`), not Radix. Add components with `vp -C apps/web exec shadcn add <name>`; reuse the primitives in `src/components/ui/` instead of one-off markup. Base UI composes with the **`render` prop, not `asChild`**; a `Button` rendering a non-button (a router `Link`) also takes `nativeButton={false}`.
- Tailwind 4, CSS-first: no `tailwind.config`; every token lives in `src/index.css`. Use semantic tokens (`bg-background`, `text-muted-foreground`, `--signal`, `--live`, `--ok`), never raw colors. `apps/web/DESIGN.md` is the design authority. State renders through `components/state-mark.tsx`; loading states are skeletons, not spinners; motion ≤ 200 ms and off under `prefers-reduced-motion`.
- Dialogs are bottom sheets on phones and centred on `sm+`; menus use `components/ui/menu-sheet.tsx`. Markdown goes through `LazyMarkdown`. Icons: `lucide-react` only. `cn()` comes from the `cn` package.
- UI copy is plain product vocabulary (Crew, Bot talks, Routines, Tools, Vault), standard status words, no themed roleplay labels.
- Every tool renders through the presentation lens (`@spriessen/present/tool-text`). **A new tool lands with its presentation and, if gated, its approval-card words** — `apps/web/src/lib/tool-coverage.test.ts` fails otherwise.
- The `@/*` alias is declared three times (`apps/web/vite.config.ts`, `apps/web/tsconfig.json`, root `vite.config.ts`) — keep them in sync. `src/routeTree.gen.ts` is generated and committed, never hand-edited.

## Conventions

- ESM only; tabs (`vp fmt` enforces); `import type` for type-only imports (`verbatimModuleSyntax`); relative imports carry explicit `.ts` extensions.
- **Shared versions live in the pnpm catalog** (`pnpm-workspace.yaml`): a dependency used by two or more workspaces is `"catalog:"` in each manifest and versioned once. Promote one the moment a second workspace needs it.
- The `@earendil-works/*` set (chord, pi-ai, pi-codemode, pi-durable, pi-schema) is pinned exact and moves in lockstep. Read each changelog's Breaking Changes before a bump — 1.5.0 changed watch shapes, view windows and stored formats.
- TypeBox is the schema language at the chord boundary and for REST payloads; chord checks schemas with pi-schema, so every schema handed to chord goes through `wire()` from `@spriessen/contracts`. Effect Schema stays inside effect services.
- Strict TS: `exactOptionalPropertyTypes` (never assign explicit `undefined` to an optional prop), `noUncheckedIndexedAccess`.

## Repo rules (set by the owner)

- **vp only** — no `npm`/`npx`/`pnpm`/bare `node` in commands, scripts, docs or CI. If vp lacks a command, use `vp pm …` and note why.
- MAX 500 LoC per file; MAX 100 LoC per function/component — at 80 LoC, split.
- Code must pass the gate above. Never claim code is "tested" without it.
- Work done = work committed: atomic commits, conventional-commit messages (`feat:`, `fix:`, `chore:`, `build:`, `docs:`).

## Pitfalls

- **Never add `vite` or `vitest` as a dependency.** vp owns them via the catalog (`vite` → `@voidzero-dev/vite-plus-core`); run `vp migrate --no-agent` if the alias drifts.
- **Owner data goes through `apps/server/src/rest/owner-scope.ts`.** A route that reads or writes a bot, session or routine checks ownership there and answers another owner's item exactly like a missing one. See `docs/SECURITY.md`.
- **Never `join` a caller-supplied id or path onto a data folder** — use `resolveInside` / `tryResolveInside` from `@spriessen/core`.
- **Webhook tokens exist only as hashes** (`tokenHash`); check with `verifyWebhookToken`, never compare, log or list a token or hash. Return plain copies from `docs.commit` callbacks: draft values die with the transaction ("Cannot use a settled overlay").
- **pi-durable: trust `dist/*.d.ts`, not the README.** Since 1.5 there is no `viewState()`: read a conversation through `readView` / `followView` (`packages/mind/src/converse/view.ts`), whose default window holds the whole transcript — pi-durable's own default is the newest 50 entries — and read one document with `harness.watchDoc`. Watch listeners take a tagged call (`call.kind === "value"`). `pi.live` is stored at version 3: a data folder 1.5 wrote cannot be opened by 1.4.
- `AssistantEntry` stores the message in `record.model[0]`; `settled.answer` is an `EntryId`; `commit()` may return `undefined`.
- `BACKGROUND_CONTEXT` is NOT exported from the chord root — import it from `@earendil-works/chord/context`.
- chord's replicated-object attach desynced over the wire in 1.4.0 (`ChordError: invalid/protocol: ack N outside 0..N`): do NOT add more replicated CRUD objects over the wire; registries, tasks, artifacts and friends are REST for this reason. Not re-verified on 1.5.
- Annotate chord `principal` callbacks with the app `Principal` type — inline literals widen and break `Host<P>` inference.
- Files Node executes directly (server, probe, smoke) must be erasable-syntax-only TS: no enums, namespaces or parameter properties.
- `tsconfig.json` files stay strict JSON (no comments).
- Structured tool outputs must be JsonValue-compatible: `type` aliases, not `interface`, for result shapes.
- Effect 4 is not Effect 3: no `Effect.catchAll` (use `Effect.match` / `catchTag` / `catchIf`); `ConfigError` comes from `"effect/Config"`; `Layer.merge` is binary; `Layer.buildWithScope` yields a `Context`; `Config`'s env provider snapshots `process.env` at first use, so tests set env at module load; `Data.TaggedError` instances yield directly. Long-lived runtimes go through `openRuntime(layer, key)` — never `Effect.scoped` around a service that must outlive the call.
- REST mind-service calls are Effects: run them with `Effect.runPromise`.
- `vp node` cannot resolve node INSIDE a `vp run` script — root scripts delegate (`vpr smoke` → the server workspace script).
- pnpm 12 gates build scripts with `allowBuilds` in `pnpm-workspace.yaml`; the listed `false` entries are vetted no-ops — never flip one without reading the script (`vp add <pkg> --allow-build <pkg>` to allow one deliberately).
- `vp install` may report "Agent skills awaiting approval" (`@tanstack/react-router`, `@tanstack/router-plugin`). Leave them: approving is the owner's call.
