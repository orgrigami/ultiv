# Spriessen

Your bots, on your own server. Chat with them, follow their work and approve what needs you.

Spriessen is a self-hosted web app for running AI bots on your own machine. Each bot gets its own persona, memory, files, tools, schedules and audit log. Bots can talk to you, talk to each other, and do things on your computer when you approve them.

It runs on any model provider [models.dev](https://models.dev) knows about: Anthropic, OpenAI, Google, OpenRouter, DeepSeek, Kenari and a couple hundred more, or a model running on your own machine. Provider keys stay on the server in `.env`. The credentials bots use live in a local encrypted vault that the model never reads.

A fresh install starts with no bots. The first one you create becomes your main bot, and you can add as many others as you like.

## Quick start

With a coding agent, the easy way: ask it to "read SETUP.md and set up Spriessen with me". It asks one short question at a time, never asks for a key in the chat, and shows the whole plan before it changes anything.

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

- **One place for everything.** The phone tab bar and the desktop sidebar both show Chat, Past chats, Needs you, Crew and Settings, so an old chat is one tap away. The sidebar also keeps your recent chats and a Find box (Cmd/Ctrl-K) that jumps to any bot, chat or screen; N starts a new chat and ? lists the shortcuts. Needs you lists pending approvals, work that restarts cut off too many times in a row (with a Retry button, since it won't run again by itself), failed tasks, routines that gave up and memory tidy suggestions, and you can approve or deny right there. On a wide screen, a task, a file or a bot's memory opens in a work pane beside the chat. Crew lists your bots; each one has its own character and a profile with Memory, Routines, Access, Files and Activity tabs that show their counts.
- **Memory that stays true.** Before each reply a bot sees the few things it remembers that your message is about, and it keeps facts current: when something changed, was wrong or stopped holding, it updates that fact instead of piling up contradictions, and the weekly tidy flags any that disagree. You can do the same from its Memory panel, where each fact links to the chat it was learned in. Past chats searches the words said in every bot's chats (each bot only ever searches its own), in English or Indonesian, misspellings and "last week" included.
- **Bots with their own state.** Each one has a persona, memory, files, a tool allowlist, cron schedules and an audit trail. Bots can find each other, send each other messages with deadlines, and work together in shared rooms.
- **An org with departments.** Bots can belong to departments. Each home — the org, each department — has one microVM shared by its bots and a shared folder of its own; department folders mount read-write into the org VM and the org's folder mounts read-only into department VMs, all with size caps. Messaging reaches across homes; `bash` never does — a bot's scripts always run in its own home's VM.
- **Any model, per bot or per chat.** Every provider whose key you set shows up in the model picker, grouped by provider. Each bot can have its own default model and effort level, and you can switch either in the middle of a chat.
- **One bash tool, three targets.** `bash` runs scripts in a [microsandbox](https://microsandbox.dev) microVM by default — a real Linux box with python, network off unless you allowlist hosts for the bot's home; files it writes end up in the bot's file store. `target: "host"` runs directly on your computer, `target: "node"` on another machine you've paired (Settings → Nodes). Each target has its own approval rules — a rule for one target never approves another — and only bots you've granted host access can use either beyond-VM target. A long command (a build, a test run) can run as a background job: the bot stays free to answer you, and the job's result wakes it when it ends.
- **A vault for credentials.** Items are sealed with AES-256-GCM, and bots only see names and masked hints. When a bot needs to use a secret, the credential broker makes the HTTP request itself, only to the hosts, methods and paths that secret is bound to. Responses are scrubbed before the bot sees them.
- **Routines.** Bots can wake on cron schedules, on webhooks they set up themselves, or on sensors (RSS, a calendar ICS feed, watched URLs). Schedules respect time zones. Webhooks are validated against a schema, retried, and dead-lettered if they keep failing.
- **Routines that cost little attention.** A schedule can start as a trial: each run shows what it would have done (the tools it tried and what it would have said) while nothing actually runs, until you press Go live; Try now runs one trial on demand. A routine with nothing new ends with "nothing to report", which shows as one quiet line and sends no notification. A webhook can give each outside thread (a GitHub issue, a Slack thread) its own chat, and take work only from the senders you list: anyone else's post only adds context to a thread's chat and never wakes the bot.
- **Background tasks.** A bot can hand long work to a sub-agent and keep chatting. The task runs in its own conversation and reports back when it's done. If the server restarts, tasks pick up where they left off, checking first that nothing they already sent goes out twice. Background work never crowds out your chats: at the model concurrency limit (`MODEL_MAX_CONCURRENCY`) your messages go first, and one slot always stays free for them.
- **Approvals.** Tools with side effects wait on an approval card. Each bot can instead let Jev judge its calls or run them without asking; see [Approval modes](#approval-modes). "Always allow" saves a rule for that tool, and it never covers the calls that always ask. You get a push notification when a bot is waiting on you.
- **Queued messages never send by themselves after a failed turn.** If a turn fails or is cut off while you have messages waiting, they stay in the queue marked "Not sent", with a Retry chip that sends them in order (or take any back with its ×).
- **Restarts don't drop a reply.** A turn the server's restart cut off carries on when it comes back, and the chat shows the bot working again. A turn cut off too many times in a row stops and shows in Needs you, with Retry.
- **No silent hangs.** If the model sends nothing for 60 seconds, or a turn runs longer than 15 minutes, the bot stops and says why in the chat. Anything it already wrote stays, and queued messages stay queued. Each bot can get more (or less) time in its edit dialog; time spent waiting on your approval doesn't count.
- **Images and files in chat.** The + menu in the composer attaches images or any other file, and you can paste or drag them in too: up to 8 per message, 10 MB each. They're saved to the bot's file store when you send. Big photos are scaled down first. The model sees images directly only if it accepts image input; otherwise the bot gets a pointer to the file, and the composer warns you. Bots can also look at image files in their store with `artifact_read`.
- **MCP connectors.** Add HTTP, SSE or stdio MCP servers from the UI, or let a bot add one (that also goes through an approval card). OAuth and headers pulled from the vault are supported, and there are a few presets.
- **Installable on your phone.** The web app is a PWA with Web Push for finished tasks, pending approvals and routine replies. The service worker only caches the offline shell.

## Models

The model list comes from [models.dev](https://models.dev). The server downloads it on first start, keeps a copy in `apps/server/var/models-dev.json`, and checks for updates once a day, so new models show up without a restart or an upgrade. Only models that can chat and call tools are listed.

- **Turning a provider on:** set its key in `.env` under the name models.dev uses for it. The provider pages on models.dev show the variable, e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `KENARI_API_KEY`.
- **The default model:** `SPRIESSEN_MODEL=provider/model`, e.g. `anthropic/claude-sonnet-4-6`. Without it, new chats use `kenari/deepseek-v4-1-flash` when Kenari is set up, otherwise the first model in the list.
- **Fewer providers in the picker:** `SPRIESSEN_PROVIDERS=anthropic,kenari` lists only those, even if other keys are set. OpenRouter alone adds about 300 models, so this helps.
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

  A provider with no key (`"env": []`) only loads when it's listed in `SPRIESSEN_PROVIDERS`, so list it there along with the others you use.

- **Refreshing by hand:** `POST /api/models/refresh`. `GET /api/models/catalog` shows where the list came from, when, and the current default.

Providers that need their own SDK (Bedrock, Vertex, Azure, Cohere) aren't wired up yet and are skipped.

**Jev** is a separate decision model from [Typesafe.AI](https://typesafe.ai) that bots use for yes/no, pick, rate and ask, and for judging approvals when a bot is in Jev approval mode. Set `TYPESAFE_API_KEY` to turn it on, and `TYPESAFE_BASE_URL` to send it through a proxy or another endpoint (default `https://api.typesafe.ai`).

## Configuration

Every setting in `.env` is optional, and the keys and URLs below can be left blank. Features whose key is missing show up as off. The ones you'll most likely care about:

| Key                                      | What it's for                                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A provider key                           | Chat and generation. See [Models](#models). You need at least one to have conversations.                       |
| `SPRIESSEN_MODEL`                        | Default model as `provider/model`                                                                              |
| `SPRIESSEN_PROVIDERS`                    | Only these providers, comma separated                                                                          |
| `TYPESAFE_API_KEY` / `TYPESAFE_BASE_URL` | Jev, the decision model, and where to reach it                                                                 |
| `VAULT_KEY`                              | Turns the vault on. Use a long random secret, e.g. `printf 'VAULT_KEY=%s\n' "$(openssl rand -hex 32)" >> .env` |
| `TINYFISH_API_KEY`                       | Live web search and fetch for bots                                                                             |
| `CALENDAR_ICS_URL`                       | A secret iCal feed, so bots know your schedule (read only)                                                     |
| `MCP_OAUTH_CALLBACK_URL`                 | OAuth callback for connectors (default `http://localhost:8787/api/mcp/oauth/callback`)                         |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web Push. Generate them once with `vpr @spriessen/server#push:keys`                                            |

Product keys start with `SPRIESSEN_`. The names from before the rename (`ULTIV_MODEL`, `ULTIV_PROVIDERS`, …) still work as a deprecated fallback and print a one-time warning at startup; the new name wins when both are set. The same goes for the webhook `x-ultiv-token` header, still accepted next to `x-spriessen-token`. (No user header is read any more: identity comes from the sign-in session.)

`.env.example` lists the rest, with a comment on each. A few tuning knobs aren't in it: `SPRIESSEN_MAX_RUNNING_TASKS` (background tasks one bot can run at once, default 3), `MAILBOX_DEADLINE_MS` (how long a bot-to-bot request waits, default 15 minutes), `SKILLS_DIR`, `SPRIESSEN_SANDBOX_IMAGE`, and the memory flags in `docs/MEMORY.md`.

Back up `VAULT_KEY` somewhere other than this machine. If you lose it or change it, every saved vault item becomes unreadable, and there's no key rotation yet.

## Using it from your phone and other devices

The server listens on every interface, and the web dev server accepts any host name, so the app works on `localhost`, your LAN address, or a Tailscale name without extra config. Set `HOST=127.0.0.1` to keep it on this machine only.

Push notifications need HTTPS. `tailscale serve` gives you that. On an iPhone, push only works after you add the app to the Home Screen.

## One bash tool, three targets

One tool, `bash`, with an optional `target`: `"vm"` (the default), `"host"`, or `"node"`.

| Target         | Where it runs                                                                               | What it can reach                                                                                                                                                                                                       | Approval                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `vm` (default) | a microsandbox microVM per home: the org's bots share one VM, each department's bots theirs | Linux in the VM: coreutils, pipes, python3, pip. Network is off unless you allowlist hosts for the home (Settings → Organization, or the department page) or open it fully per home; shared folders mount as configured | asks per call (can be auto-approved)                                                                                              |
| `host`         | **your computer, directly**                                                                 | your whole real filesystem                                                                                                                                                                                              | asks per call, **except in fully automatic mode, where it just runs**; only bots with the host-access switch on can use it at all |
| `node`         | a machine you paired (Settings → Nodes), where its agent dials in                           | the node's real filesystem, confined to the roots you registered for it                                                                                                                                                 | same rules as `host`, plus the node must be paired and connected; "Always allow" saves the exact script for that exact node only  |

Both beyond-VM targets keep the working directory between calls (a node's default directory is its first allowed root). Anything a `vm` script writes under `/home` becomes an artifact: it shows up in `artifact_list`, the web UI serves it, and it survives restarts. Deletions sync too. The file store is the source of truth. Each call copies it into the VM and copies changes back out, so if the VM crashes you don't lose anything that was already synced — and a sync only deletes a file after a verified listing, so a failed read or a VM that was recreated re-prepares instead of wiping the store. A `node` script works on the node's real files — there is no artifact sync, what it writes is already where it belongs.

Every bot runs as its own Linux user inside its home's VM — it can't see another bot's processes or files, and `/tmp` is per-bot. The shared folders are the deliberate exceptions: `/home/shared` among a home's bots, the org's folder (read-only in a department VM) and each department's folder (read-write in the org VM). Each has a size cap (1 GiB by default, editable in Crew): past it the folder turns read-only until files are removed. An org bot writing into a department folder is audited per file (path, size, bot — never content).

The microVM needs an Apple Silicon Mac, or Linux with KVM. Without virtualization, the `bash` tool reports an error and the rest of the app works fine.

Use the `host` and `node` targets only when a task really needs a machine beyond the sandbox. A bot can use either only when you've turned host access on — the switch sits at org, department and bot level in Crew, and with it off the calls are refused outright; even fully automatic mode can't run them. In manual and Jev mode they ask every time: Jev never decides them. A beyond-VM card offers "Always allow this exact command on this computer", which saves a rule for that exact script only, character for character — and on a node, for that exact node; any other script, even one that differs by a space, still asks. The rule shows in the bot's Access tab, where you can remove it. Fully automatic mode runs them without asking, so only use that mode for a bot you'd trust with a shell on your computers.

Pairing a node: Settings → Nodes mints a pairing token shown once; run the agent (`apps/agent`) on that machine with the token and it dials in, ready for `target: "node"` scripts confined to the roots you registered. Revoke kills its connection and its token at once.

## Approval modes

Each bot has an approval mode. The chip next to the bot's name in the chat header shows it (Manual, Jev or YOLO) and switches it; you can also set it on the bot's Access tab in Crew or in its edit dialog. It applies to all of that bot's chats. Switching to YOLO asks you to confirm first and lists what still asks you.

- **Manual, ask me** (the default). Every gated call waits for your card, unless you've used "Always allow" for that tool.
- **Jev decides.** Jev judges each gated call, looking at the tool's description, the bot's description, your latest message in the chat and the bot's last five tool calls, with secrets redacted. It runs the calls it's confident about, refuses the ones it's confident are wrong, and hands the rest to you as a normal card. A call that's too complex to judge (command substitution, more than three chained commands, more than ten targets at once) goes back to the bot with a note to split it. A destructive call your latest message didn't ask for goes back with a note to explain why or ask you first, and one you did ask for needs a higher score to run without you. If the same call is sent back a third time, you get the card. Each decision shows as a short line under the tool call in the chat. If Jev isn't set up or doesn't answer within 8 seconds, you get the card. Jev never decides bash's `host` and `node` targets.
- **YOLO (fully automatic).** Gated calls run without asking, bash's `host` and `node` targets included.

In every mode, these always come to you as a card: a credential's first use on a new host, a connector's first use, connector changes, and `secret_request`.

## Security

- **You sign in with a passcode** (and passkeys, once you add one in Settings). The first visit from the server's own machine (localhost) asks you to choose one; every device then signs in with it, over the LAN and the tailnet too. Sessions are HttpOnly cookies that expire after 30 idle days, sign-in throttles wrong guesses, and identity comes from the session only (the old `x-spriessen-user` header is not read any more). Every route that touches your data asks one helper (`apps/server/src/rest/owner-scope.ts`), and anything that isn't yours looks exactly like a missing item. On the first start after upgrading, your existing bots and chats move to the account automatically; `vpr @spriessen/server#owners:dry-run` (server stopped) shows what would move first.
- **Forgot the passcode?** Run `vpr @spriessen/server#recover:access` on the host (stop the server first). It prints a fresh passcode and signs every session out; your data is untouched. Then start the server and sign in with the printed code.
- **Secrets don't reach the model.** Bots refer to vault items by name or ask for one with `secret_request`. You type the value into a masked field, it goes to the server, and it's stored sealed. It never shows up in transcripts, audit logs or notifications.
- **Risky tools wait for you.** Read-only tools run freely. Tools with side effects wait for approval, or follow the bot's [approval mode](#approval-modes). Some always ask, whatever the mode or the allow list says: using a credential on a new host for the first time, a connector's first use, changing connectors, and `secret_request`. For bash's `host` and `node` targets, "Always allow" saves only the exact script on the card — on a node, for that exact node (removable in the bot's Access tab) — and Jev never decides them, but fully automatic mode runs them.
- **Outbound requests are limited.** `http_request` only does https, has an SSRF/DNS guard, sticks to each secret's host/method/path bindings, caps redirects and response size, and scrubs responses.
- **File paths can't leave their folder.** Every file store resolves paths with symlinks followed and refuses `../`, absolute paths and links that point outside; see `docs/SECURITY.md`.
- **Webhook tokens are stored as hashes.** A token is shown once, when the webhook is made or when you issue a New token, and the server keeps only its SHA-256 hash and compares in constant time. Existing tokens are converted on start, so old URLs keep working; see `docs/SECURITY.md` for the rollback note.
- **`.env` stays on the server.** It's never printed or sent to the client.

## Layout

```
apps/server         Node 24 server: REST, chord replication, triggers (cron/webhooks/sensors). Thin layer over the mind.
apps/web            React 19 + TanStack Router + shadcn (Base UI) + Tailwind 4 client
packages/core       tagged errors and the bridge between promises and Effect
packages/ext        tools, plugins, registry, vault, credential broker, shells
packages/mind       the bots themselves: models, converse, decide, act, generate, tasks, profiles, routines, memory
packages/contracts  TypeBox chord contracts shared by server and web
packages/about      the built-in skills every bot gets: Spriessen's own docs, as Agent Skills
```

It's a pnpm monorepo written with Effect. Each profile is one bot running in a shared runtime. Sessions replicate over chord; the registries (sessions, models, artifacts, webhooks, cron, audit) are plain REST.

## Development

Use `vp` for everything, not `npm`, `pnpm`, `node`, `tsc` or `vitest` directly:

```sh
vp install                                  # dependencies
vp check --fix                              # format and lint
vp exec tsc -p packages/ext/tsconfig.json   # typecheck one workspace (all seven have to pass)
vp test                                     # unit tests (offline: no models.dev, no providers)
SPRIESSEN_REAL_VM=1 vp test --run packages/ext/src/shell/real-vm.test.ts   # opt-in: the isolation suite on real VMs (boots throwaway microVMs, ~15 s)
vp -C apps/web build                        # production web build
vp run smoke                                # starts the whole stack offline on a random port and hits the REST API
```

Before a change goes in, I run `vp check`, the seven typechecks, `vp test`, the web build and `vp run smoke`, in that order. To try your real providers and Jev (needs keys): `vp node --env-file=.env packages/mind/src/probe.ts`.

## More docs

- `AGENTS.md`: developer guide (layout, `vp` rules, the checks above, conventions, pitfalls)
- `docs/ROUTINES.md`: how cron, webhooks and sensors stay durable and get delivered
- `docs/MEMORY.md`: how memory works (tiers, recall, guard, tidy)
- `docs/SKILLS.md`: how skills are stored, loaded, installed and improved
- `docs/SECURITY.md`: path confinement, owner scoping, VM isolation and shared-folder caps, webhook token storage
- `docs/THREAT_MODEL.md`: what the isolation does and doesn't claim, per surface
- `docs/CAPACITY.md`: measured VM footprint, boot times and the cost of the folder caps
