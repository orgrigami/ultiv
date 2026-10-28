# Ultiv

Ultiv is a self-hosted web app for running AI bots on your own machine. Each bot gets its own persona, memory, files, tools, schedules and audit log. Bots can talk to you, talk to each other, and do things on your computer when you approve them.

Ultiv is built with Hermes and Grok.

It's a pnpm monorepo with a Node API server, a React client, and a "mind" package that hosts the bots. It's written with Effect. Provider keys stay on the server in `.env`, and the credentials bots use live in a local encrypted vault that the model never reads.

The default bot is called Ultius. You can add as many others as you like.

## What it does

- **Bots with their own state.** Each one has a persona, memory, files, a tool allowlist, cron schedules and an audit trail. Bots can find each other, send each other messages with deadlines, and work together in shared rooms.
- **Two shells.** `bash` runs scripts in a [microsandbox](https://microsandbox.dev) microVM, which is a real Linux box with python, network access and `apt-get`. Files it writes end up in the bot's file store. `bash_host` runs directly on your computer and always asks first.
- **A vault for credentials.** Items are sealed with AES-256-GCM, and bots only see names and masked hints. When a bot needs to use a secret, the credential broker makes the HTTP request itself, only to the hosts, methods and paths that secret is bound to. Responses are scrubbed before the bot sees them.
- **Routines.** Bots can wake on cron schedules, on webhooks they set up themselves, or on sensors (RSS, a calendar ICS feed, watched URLs). Schedules respect time zones. Webhooks are validated against a schema, retried, and dead-lettered if they keep failing.
- **Background tasks.** A bot can hand long work to a sub-agent and keep chatting. The task runs in its own conversation and reports back when it's done. If the server restarts, tasks pick up where they left off.
- **Approvals.** Tools with side effects wait on an approval card. "Always allow" is per tool and never covers the dangerous ones. You get a push notification when a bot is waiting on you.
- **MCP connectors.** Add HTTP, SSE or stdio MCP servers from the UI, or let a bot add one (that also goes through an approval card). OAuth and headers pulled from the vault are supported, and there are a few presets.
- **Installable on your phone.** The web app is a PWA with Web Push for finished tasks, pending approvals and routine replies. The service worker only caches the offline shell.

## Requirements

- Node 24 (pinned in `mise.toml`) and pnpm 12. You reach both through [Vite+](https://viteplus.dev/) (`vp`), which is the only toolchain this repo uses. Install it once with `curl -fsSL https://vite.plus | bash`.
- For the `bash` microVM: an Apple Silicon Mac, or Linux with KVM. Everything else runs anywhere Node 24 does. Without virtualization, the `bash` tool reports an error and the rest of the app works fine.

## Install and run

```sh
git clone https://github.com/orgrigami/ultiv.git && cd ultiv
vp install              # installs dependencies (vp runs pnpm for you)
cp .env.example .env    # fill in the keys you want to use
vp run dev              # API on :8787, web on :5173
```

Then open http://localhost:5173, create a bot and start chatting. If `vp` isn't on your PATH, `AGENTS.md` has notes on that.

Easier installation steps incoming™.

### Environment

Every key in `.env` is optional. Features whose key is missing just show up as off. The ones you'll most likely care about:

| Key | What it's for |
| --- | --- |
| `KENARI_API_KEY` | LLM gateway for chat and generation. You need this one to have conversations. |
| `KENARI_MODEL` | Optional model override (default `deepseek-v4-1-flash`) |
| `TYPESAFE_API_KEY` | Typesafe.AI decision model (Jev), used for yes/no, pick, rate and ask |
| `VAULT_KEY` | Turns the vault on. Use a long random secret, e.g. `printf 'VAULT_KEY=%s\n' "$(openssl rand -hex 32)" >> .env` |
| `MCP_OAUTH_CALLBACK_URL` | OAuth callback for connectors (default `http://localhost:8787/api/mcp/oauth/callback`) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web Push. Generate them with `vpr @ultiv/server#push:keys` |

`.env.example` lists the rest, with a comment on each.

Back up `VAULT_KEY` somewhere other than this machine. If you lose it or change it, every saved vault item becomes unreadable, and there's no key rotation yet.

## The two shells

| Tool | Where it runs | What it can reach | Approval |
| --- | --- | --- | --- |
| `bash` | a microsandbox microVM per workspace | full Linux: coreutils, pipes, python3, pip, network, `apt-get` | asks per call (can be auto-approved) |
| `bash_host` | **your computer, directly** | your whole real filesystem | asks per call, **never auto-approved** |

Both keep the working directory between calls. Anything a `bash` script writes under `/home` becomes an artifact: it shows up in `artifact_list`, the web UI serves it, and it survives restarts. Deletions sync too. The file store is the source of truth. Each call copies it into the VM and copies changes back out, so if the VM crashes you don't lose anything that was already synced.

Use `bash_host` only when a task really needs your actual machine. It's left out of "always allow" on purpose, because the approval is the safety check.

## Layout

```
apps/server         Node 24 server: REST, chord replication, triggers (cron/webhooks/sensors). Thin layer over the mind.
apps/web            React 19 + TanStack Router + shadcn (Base UI) + Tailwind 4 client
packages/core       tagged errors and the bridge between promises and Effect
packages/ext        tools, plugins, registry, vault, credential broker, shells
packages/mind       the bots themselves: converse, decide, act, generate, tasks, profiles, routines, memory
packages/contracts  TypeBox chord contracts shared by server and web
```

Each profile is one bot running in a shared runtime. Sessions replicate over chord. The registries (sessions, artifacts, webhooks, cron, audit) are plain REST. `AGENTS.md` is the full developer guide: what's in each package, how to use `vp`, conventions, and known pitfalls.

## Development

Use `vp` for everything, not `npm`, `pnpm`, `node`, `tsc` or `vitest` directly:

```sh
vp install                                  # dependencies
vp check --fix                              # format and lint
vp exec tsc -p packages/ext/tsconfig.json   # typecheck one workspace (all six have to pass)
vp test                                     # unit tests
vp -C apps/web build                        # production web build
vp run smoke                                # starts the whole stack offline on a random port and hits the REST API
```

Before a change goes in, I run `vp check`, the six typechecks, `vp test`, the web build and `vp run smoke`, in that order. To try a real provider (needs real keys): `vp node --env-file=.env packages/mind/src/probe.ts`.

## Security

- **There's no login yet.** The server takes the user from the `x-ultiv-user` header, and requests without it count as `guest`. Data is partitioned by owner, and the identity code lives in one file (`apps/server/src/identity.ts`) so a real sign-in can replace it later. Until then, run Ultiv on a machine and network you control.
- **Secrets don't reach the model.** Bots refer to vault items by name or ask for one with `secret_request`. You type the value into a masked field, it goes to the server, and it's stored sealed. It never shows up in transcripts, audit logs or notifications.
- **Risky tools wait for you.** Read-only tools run freely. Tools with side effects wait for approval. Some can never be blanket-allowed: deleting artifacts, changing connectors, using a credential on a new host for the first time, and `bash_host`.
- **Outbound requests are limited.** `http_request` only does https, has an SSRF/DNS guard, sticks to each secret's host/method/path bindings, caps redirects and response size, and scrubs responses.
- **`.env` stays on the server.** It's never printed or sent to the client.

## More docs

- `AGENTS.md`: developer guide (layout, `vp` rules, the checks above, conventions, pitfalls)
- `docs/ROUTINES.md`: how cron, webhooks and sensors stay durable and get delivered
- `docs/MEMORY.md`: how memory works (tiers, recall, guard, tidy)
