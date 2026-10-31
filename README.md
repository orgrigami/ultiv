# Spreissen

Your bots, on your own server. Chat with them, follow their work and approve what needs you.

Spreissen is a self-hosted web app for running AI bots on your own machine. Each bot gets its own persona, memory, files, tools, schedules and audit log. Bots can talk to you, talk to each other, and do things on your computer when you approve them.

It runs on any model provider [models.dev](https://models.dev) knows about: Anthropic, OpenAI, Google, OpenRouter, DeepSeek, Kenari and a couple hundred more, or a model running on your own machine. Provider keys stay on the server in `.env`. The credentials bots use live in a local encrypted vault that the model never reads.

A fresh install starts with no bots. The first one you create becomes your main bot, and you can add as many others as you like.

## Quick start

You need [Vite+](https://viteplus.dev/) (`vp`), which brings Node 24 and pnpm with it. It's the only toolchain this repo uses.

```sh
curl -fsSL https://vite.plus | bash     # once, installs vp
git clone https://github.com/orgrigami/ultiv.git && cd ultiv   # the repository is still orgrigami/ultiv
vp install
cp .env.example .env
```

Put at least one provider key in `.env` (for example `ANTHROPIC_API_KEY` or `KENARI_API_KEY`). Setting `VAULT_KEY` too is a good idea; see [Configuration](#configuration). Then:

```sh
vp run dev        # API on :8787, web on :5173
```

Open http://localhost:5173 and create your first bot. **Settings** shows a quick server check: which keys are set or missing (names only, never values), the models in use, whether the microVM sandbox can run, and a notice if the server is reachable from your network. If `vp` isn't on your PATH afterwards, add `~/.vite-plus/bin`.

## What it does

- **One place for everything.** The phone tab bar and the desktop sidebar both show Chat, Past chats, Needs you, Crew and Settings, so an old chat is one tap away. The sidebar also keeps your recent chats and a Find box (Cmd/Ctrl-K) that jumps to any bot, chat or screen; N starts a new chat and ? lists the shortcuts. Needs you lists pending approvals, failed tasks, routines that gave up and memory tidy suggestions, and you can approve or deny right there. On a wide screen, a task, a file or a bot's memory opens in a work pane beside the chat. Crew lists your bots; each one has its own character and a profile with Memory, Routines, Access, Files and Activity tabs that show their counts.
- **Bots with their own state.** Each one has a persona, memory, files, a tool allowlist, cron schedules and an audit trail. Bots can find each other, send each other messages with deadlines, and work together in shared rooms.
- **Any model, per bot or per chat.** Every provider whose key you set shows up in the model picker, grouped by provider. Each bot can have its own default model and effort level, and you can switch either in the middle of a chat.
- **Two shells.** `bash` runs scripts in a [microsandbox](https://microsandbox.dev) microVM, which is a real Linux box with python, network access and `apt-get`. Files it writes end up in the bot's file store. `bash_host` runs directly on your computer and asks first, unless the bot is in fully automatic mode.
- **A vault for credentials.** Items are sealed with AES-256-GCM, and bots only see names and masked hints. When a bot needs to use a secret, the credential broker makes the HTTP request itself, only to the hosts, methods and paths that secret is bound to. Responses are scrubbed before the bot sees them.
- **Routines.** Bots can wake on cron schedules, on webhooks they set up themselves, or on sensors (RSS, a calendar ICS feed, watched URLs). Schedules respect time zones. Webhooks are validated against a schema, retried, and dead-lettered if they keep failing.
- **Background tasks.** A bot can hand long work to a sub-agent and keep chatting. The task runs in its own conversation and reports back when it's done. If the server restarts, tasks pick up where they left off.
- **Approvals.** Tools with side effects wait on an approval card. Each bot can instead let Jev judge its calls or run them without asking; see [Approval modes](#approval-modes). "Always allow" saves a rule for that tool, and it never covers the calls that always ask. You get a push notification when a bot is waiting on you.
- **Images and files in chat.** The + menu in the composer attaches images or any other file, and you can paste or drag them in too: up to 8 per message, 10 MB each. They're saved to the bot's file store when you send. Big photos are scaled down first. The model sees images directly only if it accepts image input; otherwise the bot gets a pointer to the file, and the composer warns you. Bots can also look at image files in their store with `artifact_read`.
- **MCP connectors.** Add HTTP, SSE or stdio MCP servers from the UI, or let a bot add one (that also goes through an approval card). OAuth and headers pulled from the vault are supported, and there are a few presets.
- **Installable on your phone.** The web app is a PWA with Web Push for finished tasks, pending approvals and routine replies. The service worker only caches the offline shell.

## Models

The model list comes from [models.dev](https://models.dev). The server downloads it on first start, keeps a copy in `apps/server/var/models-dev.json`, and checks for updates once a day, so new models show up without a restart or an upgrade. Only models that can chat and call tools are listed.

- **Turning a provider on:** set its key in `.env` under the name models.dev uses for it. The provider pages on models.dev show the variable, e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `KENARI_API_KEY`.
- **The default model:** `SPREISSEN_MODEL=provider/model`, e.g. `anthropic/claude-sonnet-4-6`. Without it, new chats use `kenari/deepseek-v4-1-flash` when Kenari is set up, otherwise the first model in the list.
- **Fewer providers in the picker:** `SPREISSEN_PROVIDERS=anthropic,kenari` lists only those, even if other keys are set. OpenRouter alone adds about 300 models, so this helps.
- **Kenari stays fresher than models.dev:** the gateway's own `https://kenari.id/v1/models` listing is fetched alongside models.dev (cached in `apps/server/var/kenari-models.json`, revalidated every 6 hours) and **replaces** the Kenari model set — models already live on the gateway appear, retired ones drop. `KENARI_MODELS_URL=off` disables it; `MODELS_DEV_URL=off` keeps the whole catalog offline.
- **Models models.dev doesn't have, or a local server:** add them to `apps/server/var/models.local.json`, in the same format as models.dev. The file is read on every catalog refresh. This adds an Ollama server:

  ```json
  {
    "ollama": {
      "name": "Ollama",
      "npm": "@ai-sdk/openai-compatible",
      "api": "http://127.0.0.1:11434/v1",
      "env": [],
      "models": {
        "qwen3:14b": {
          "name": "Qwen3 14B",
          "tool_call": true,
          "limit": { "context": 40960, "output": 8192 }
        }
      }
    }
  }
  ```

  A provider with no key (`"env": []`) only loads when it's listed in `SPREISSEN_PROVIDERS`, so list it there along with the others you use.

- **Refreshing by hand:** `POST /api/models/refresh`. `GET /api/models/catalog` shows where the list came from, when, and the current default.

Providers that need their own SDK (Bedrock, Vertex, Azure, Cohere) aren't wired up yet and are skipped.

**Jev** is a separate decision model from [Typesafe.AI](https://typesafe.ai) that bots use for yes/no, pick, rate and ask, and for judging approvals when a bot is in Jev approval mode. Set `TYPESAFE_API_KEY` to turn it on, and `TYPESAFE_BASE_URL` to send it through a proxy or another endpoint (default `https://api.typesafe.ai`).

## Configuration

Every setting in `.env` is optional, and the keys and URLs below can be left blank. Features whose key is missing show up as off. The ones you'll most likely care about:

| Key                                      | What it's for                                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A provider key                           | Chat and generation. See [Models](#models). You need at least one to have conversations.                       |
| `SPREISSEN_MODEL`                        | Default model as `provider/model`                                                                              |
| `SPREISSEN_PROVIDERS`                    | Only these providers, comma separated                                                                          |
| `TYPESAFE_API_KEY` / `TYPESAFE_BASE_URL` | Jev, the decision model, and where to reach it                                                                 |
| `VAULT_KEY`                              | Turns the vault on. Use a long random secret, e.g. `printf 'VAULT_KEY=%s\n' "$(openssl rand -hex 32)" >> .env` |
| `TINYFISH_API_KEY`                       | Live web search and fetch for bots                                                                             |
| `CALENDAR_ICS_URL`                       | A secret iCal feed, so bots know your schedule (read only)                                                     |
| `MCP_OAUTH_CALLBACK_URL`                 | OAuth callback for connectors (default `http://localhost:8787/api/mcp/oauth/callback`)                         |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web Push. Generate them once with `vpr @spreissen/server#push:keys`                                            |

Product keys start with `SPREISSEN_`. The names from before the rename (`ULTIV_MODEL`, `ULTIV_PROVIDERS`, …) still work as a deprecated fallback and print a one-time warning at startup; the new name wins when both are set. The same goes for the `x-ultiv-user` and `x-ultiv-token` headers, which are still accepted next to `x-spreissen-user` and `x-spreissen-token`.

`.env.example` lists the rest, with a comment on each. A few tuning knobs aren't in it: `SPREISSEN_MAX_RUNNING_TASKS` (background tasks one bot can run at once, default 3), `MAILBOX_DEADLINE_MS` (how long a bot-to-bot request waits, default 15 minutes), `SKILLS_DIR`, `SPREISSEN_SANDBOX_IMAGE`, and the memory flags in `docs/MEMORY.md`.

Back up `VAULT_KEY` somewhere other than this machine. If you lose it or change it, every saved vault item becomes unreadable, and there's no key rotation yet.

## Using it from your phone and other devices

The server listens on every interface, and the web dev server accepts any host name, so the app works on `localhost`, your LAN address, or a Tailscale name without extra config. Set `HOST=127.0.0.1` to keep it on this machine only.

Push notifications need HTTPS. `tailscale serve` gives you that. On an iPhone, push only works after you add the app to the Home Screen.

## The two shells

| Tool        | Where it runs                        | What it can reach                                              | Approval                                                              |
| ----------- | ------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------- |
| `bash`      | a microsandbox microVM per workspace | full Linux: coreutils, pipes, python3, pip, network, `apt-get` | asks per call (can be auto-approved)                                  |
| `bash_host` | **your computer, directly**          | your whole real filesystem                                     | asks per call, **except in fully automatic mode, where it just runs** |

Both keep the working directory between calls. Anything a `bash` script writes under `/home` becomes an artifact: it shows up in `artifact_list`, the web UI serves it, and it survives restarts. Deletions sync too. The file store is the source of truth. Each call copies it into the VM and copies changes back out, so if the VM crashes you don't lose anything that was already synced.

The microVM needs an Apple Silicon Mac, or Linux with KVM. Without virtualization, the `bash` tool reports an error and the rest of the app works fine.

Use `bash_host` only when a task really needs your actual machine. In manual and Jev mode it always asks: Jev never decides it, and "Always allow" on its card doesn't save a rule, because the approval is the safety check. Fully automatic mode runs it without asking, so only use that mode for a bot you'd trust with a shell on your computer.

## Approval modes

Each bot has an approval mode. The chip next to the bot's name in the chat header shows it (Manual, Jev or YOLO) and switches it; you can also set it on the bot's Access tab in Crew or in its edit dialog. It applies to all of that bot's chats. Switching to YOLO asks you to confirm first and lists what still asks you.

- **Manual, ask me** (the default). Every gated call waits for your card, unless you've used "Always allow" for that tool.
- **Jev decides.** Jev judges each gated call, looking at the tool's description, the bot's description, your latest message in the chat and the bot's last five tool calls, with secrets redacted. It runs the calls it's confident about, refuses the ones it's confident are wrong, and hands the rest to you as a normal card. A call that's too complex to judge (command substitution, more than three chained commands, more than ten targets at once) goes back to the bot with a note to split it. A destructive call your latest message didn't ask for goes back with a note to explain why or ask you first, and one you did ask for needs a higher score to run without you. If the same call is sent back a third time, you get the card. Each decision shows as a short line under the tool call in the chat. If Jev isn't set up or doesn't answer within 8 seconds, you get the card. Jev never decides `bash_host`.
- **YOLO (fully automatic).** Gated calls run without asking, `bash_host` included.

In every mode, these always come to you as a card: a credential's first use on a new host, a connector's first use, connector changes, and `secret_request`.

## Security

- **There's no login yet.** The server takes the user from the `x-spreissen-user` header, and requests without it count as `guest`. Data is partitioned by owner: every REST route that touches owner data checks it in one helper (`apps/server/src/rest/owner-scope.ts`), and another owner's item looks exactly like a missing one. The identity code lives in one file (`apps/server/src/identity.ts`) so a real sign-in can replace it later. Until then, run Spreissen on a machine and network you control.
- **Secrets don't reach the model.** Bots refer to vault items by name or ask for one with `secret_request`. You type the value into a masked field, it goes to the server, and it's stored sealed. It never shows up in transcripts, audit logs or notifications.
- **Risky tools wait for you.** Read-only tools run freely. Tools with side effects wait for approval, or follow the bot's [approval mode](#approval-modes). Some always ask, whatever the mode or the allow list says: using a credential on a new host for the first time, a connector's first use, changing connectors, and `secret_request`. `bash_host` can't be saved as an "Always allow" rule and Jev never decides it, but fully automatic mode runs it.
- **Outbound requests are limited.** `http_request` only does https, has an SSRF/DNS guard, sticks to each secret's host/method/path bindings, caps redirects and response size, and scrubs responses.
- **File paths can't leave their folder.** Every file store resolves paths with symlinks followed and refuses `../`, absolute paths and links that point outside; see `docs/SECURITY.md`.
- **`.env` stays on the server.** It's never printed or sent to the client.

## Layout

```
apps/server         Node 24 server: REST, chord replication, triggers (cron/webhooks/sensors). Thin layer over the mind.
apps/web            React 19 + TanStack Router + shadcn (Base UI) + Tailwind 4 client
packages/core       tagged errors and the bridge between promises and Effect
packages/ext        tools, plugins, registry, vault, credential broker, shells
packages/mind       the bots themselves: models, converse, decide, act, generate, tasks, profiles, routines, memory
packages/contracts  TypeBox chord contracts shared by server and web
packages/about      the built-in skills every bot gets: Spreissen's own docs, as Agent Skills
```

It's a pnpm monorepo written with Effect. Each profile is one bot running in a shared runtime. Sessions replicate over chord; the registries (sessions, models, artifacts, webhooks, cron, audit) are plain REST.

## Development

Use `vp` for everything, not `npm`, `pnpm`, `node`, `tsc` or `vitest` directly:

```sh
vp install                                  # dependencies
vp check --fix                              # format and lint
vp exec tsc -p packages/ext/tsconfig.json   # typecheck one workspace (all seven have to pass)
vp test                                     # unit tests (offline: no models.dev, no providers)
vp -C apps/web build                        # production web build
vp run smoke                                # starts the whole stack offline on a random port and hits the REST API
```

Before a change goes in, I run `vp check`, the seven typechecks, `vp test`, the web build and `vp run smoke`, in that order. To try your real providers and Jev (needs keys): `vp node --env-file=.env packages/mind/src/probe.ts`.

## More docs

- `AGENTS.md`: developer guide (layout, `vp` rules, the checks above, conventions, pitfalls)
- `docs/ROUTINES.md`: how cron, webhooks and sensors stay durable and get delivered
- `docs/MEMORY.md`: how memory works (tiers, recall, guard, tidy)
- `docs/SKILLS.md`: how skills are stored, loaded, installed and improved
- `docs/SECURITY.md`: path confinement, owner scoping and webhook token storage
