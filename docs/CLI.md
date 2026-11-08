# The `spriessen` command

A terminal client and host for the same app the web runs: the same server,
the same bots, the same approval cards. It talks to a server over the
surfaces the web uses (REST, the chord `Session` object, the `/push` live
signals), so nothing a bot does differs by client. Code: `apps/cli`.

## Installing

One line, on any machine with git and [Vite+](https://viteplus.dev) (`vp`):

```sh
curl -fsSL https://raw.githubusercontent.com/orgrigami/ultiv/main/scripts/install.sh | sh
```

(The repository is private, so the raw URL needs access too: from a clone,
`sh scripts/install.sh` does the same, and `SPRIESSEN_REPO=git@github.com:orgrigami/ultiv.git`
clones over SSH.) Then:

```sh
$EDITOR ~/.spriessen/.env      # a model provider key, e.g. KENARI_API_KEY=…
spriessen daemon install       # the server + web app on :8787, kept running
spriessen login                # the first time, this sets your passcode
spriessen doctor               # checks each step and says what to fix
spriessen models default kenari/deepseek-v4-1-flash   # what new chats start on
spriessen bots new Wren --description "my right hand" # the first bot is the main bot
spriessen                      # the terminal UI (or: spriessen open, for the web app)
```

`spriessen doctor` walks that path in order (the server answers, a
passcode is set, you're signed in, a provider key is set, a workspace
default model exists, there is a bot, the daemon is installed) and prints
the command that fixes each problem; it exits 1 while something is wrong.
Optional extras (Jev, web search, push, email) are listed as what they
would turn on, never as failures.

Everything lives in **`~/.spriessen`** (`SPRIESSEN_HOME` moves it):

| Path       | Holds                                                                              |
| ---------- | ---------------------------------------------------------------------------------- |
| `sources/` | the code (a git checkout)                                                          |
| `data/`    | everything the server keeps: chats, bots, memory, vault, files, sign-in, audit log |
| `.env`     | your keys (0600; created with a fresh `VAULT_KEY` — back it up with `data/`)       |
| `config/`  | the CLI's sign-in and node token (0600)                                            |
| `logs/`    | daemon logs on macOS (Linux uses journald)                                         |

Only the `spriessen` command lives elsewhere (`~/.local/bin`, `SPRIESSEN_BIN`),
and the service files where systemd/launchd require them. `spriessen data`
prints every location. Backing up is copying `~/.spriessen` minus `sources/`.

**Updating:** `spriessen update` fetches, fast-forwards the source, rebuilds
and restarts any installed daemon; `--check` only lists what is new. Running
the install line again does the same. Neither merges, rebases or touches your
edits: with uncommitted changes, local commits, a detached HEAD or no
upstream they say why and change nothing.

What restarts: each installed daemon (`server`, `node`) restarts onto the
new code. Anything you started by hand (a foreground `spriessen serve`, a
`spriessen node`, an open terminal UI, the dev server in tmux) keeps running
the old code until you restart it; `node --watch` reloads the dev server on
its own unless dependencies changed. The two differ only at the edges: the
install line also clones and creates `.env` when they are missing and
follows `SPRIESSEN_BRANCH` (main); `update` follows the branch's upstream
and has `--check`.

**From an existing checkout:** `sh scripts/install-cli.sh` builds it and puts
the launcher in `~/.local/bin` (`--prefix`, `--uninstall`); the launcher runs
with the Node `vp node` resolves, never the first `node` on PATH. An install
from before the home keeps its data in `apps/server/var/` (the server warns
once at start); stop the server and run `spriessen data move` to bring it
into `~/.spriessen/data`. The move refuses while any server has the data
open, never merges into existing data, and gives bots fresh microVMs (their
names follow the folder path; the old VMs are removed). A config folder in
`~/.config/spriessen` moves on its own and leaves a symlink.

Without installing: `vp -C apps/cli build`, then `vp node
apps/cli/bin/spriessen.mjs …`; or `vpx apps/cli/src/main.ts` from source.

## Signing in

`spriessen login [--server <url>]` asks for the server's passcode (no echo;
piped input works for scripts) and keeps the session cookie the web's own
sign-in returns in `~/.spriessen/config/credentials.json` (0600, folder
0700; `SPRIESSEN_CONFIG_DIR` moves it). The passcode is never stored. On a
fresh install, run on the host itself, login sets the first passcode. The
session slides like a browser's (30 days). `logout` ends it on the server
too; `status` says where you stand. A cookie saved for one server is never
sent to another.

Which server: `--server`, then `SPRIESSEN_SERVER_URL`, then the saved one,
then `http://127.0.0.1:8787`.

You rarely need `login` by hand: any command that finds you signed out, in
a terminal, asks for the passcode right there and carries on. Scripts (no
terminal, or `--json`) get the sentence and exit 1 instead.

## Commands, help and naming things

Every command lives in one table (`apps/cli/src/table.ts`): `spriessen
--help` lists them by what they are for (Talk, See, Decide, Set up, Host),
`spriessen help <command>` (or `<command> --help`) shows its flags and
examples, and `spriessen completion bash|zsh|fish` prints shell
completion from the same table. A mistyped command or flag is refused
before anything runs, with the nearest real one ("Did you mean `spriessen
chats`?", "has no --bto flag. Did you mean --bot?").

Naming is the same everywhere, the TUI's `/bot` included: a bot is its
id, its name in any case, or the start of its name when only one bot
starts that way (`--bot wi` → Willow; `--bot w` with Wren and Willow says
both). Chats, tasks and cards are their id or the start of it, at least
4 characters; lists print the short form (8 characters, or 13 for a main
chat's `main-…` id).

Line output gets a little colour on a terminal, never into a pipe;
`NO_COLOR` turns it off, `FORCE_COLOR=1` on.

## When something fails

Every command, the UI included, ends a failure with a sentence and the
command that fixes it (not signed in, the server not answering, a wrong
passcode, a bot or chat that doesn't exist and which ones do), never a
stack trace, and exits 1. `SPRIESSEN_DEBUG=1` adds the full error
underneath.

## The terminal UI

`spriessen` (or `spriessen chat --bot <name>`, or `chat --chat <id>` for one
chat) opens the chat with the main bot, or the one you name. One screen,
the web's places:

| Key         | Does                                                               |
| ----------- | ------------------------------------------------------------------ |
| enter       | send (while the bot works: steer the running turn)                 |
| ctrl-r      | arm the next send as a redirect (stop and answer this)             |
| esc         | answer the waiting card, else stop the reply; closes a panel       |
| a / d / A   | on a card: approve / deny / always allow (where the web offers it) |
| i           | leave the card, back to typing                                     |
| ctrl-t      | send messages a failed run left queued (never sent by themselves)  |
| tab         | complete a half-typed /command, else Needs you ↔ chat              |
| ctrl-k      | pick a bot                                                         |
| ctrl-o      | pick one of this bot's chats (newest first)                        |
| ctrl-n      | a new chat with this bot                                           |
| pgup / pgdn | scroll                                                             |
| ctrl-c      | quit (the terminal is always restored)                             |

Type a slash command into the composer for what the web puts on buttons.
A half-typed one shows what it could be under the composer; tab completes
it; `/help` opens a panel with every key and command.

| Command        | Does                                                                     |
| -------------- | ------------------------------------------------------------------------ |
| `/help`        | the keys and commands panel (esc closes it)                              |
| `/new`         | a new chat with this bot                                                 |
| `/chats`       | the chat picker (ctrl-o)                                                 |
| `/bot [name]`  | switch bots (the start of a name is enough; bare: the picker)            |
| `/model [id]`  | this chat's model (bare: pick from the list; the effort carries over)    |
| `/edit [text]` | edit your last message in a new chat (bare `/edit` puts it in the draft) |
| `/branch`      | continue from the bot's last reply in a new chat                         |
| `/copy`        | the last reply to your clipboard (OSC 52, so over SSH too)               |
| `/retry`       | send what a failed run left queued (ctrl-t)                              |
| `/stop`        | stop the reply                                                           |
| `/test`        | save your last message as a test (`spriessen tests run` replays it)      |
| `/open`        | this chat in the web app                                                 |

`//text` sends "/text" as a message. The old chat never changes when you
branch or edit. Tool calls read in the web's words (`@spriessen/present`);
task results, routine wake-ups, webhooks and bot mail read as one dim line
each (the web's cards, in words), never as something you typed; a bot's
reaction shows as "Wren reacted 👍 Got it". Thinking stays out of the
default view; a card takes the keyboard when it arrives, unless you are
mid-sentence. The header shows the chat's model and the tokens it has used
(≥ 90 columns); wide terminals (≥ 100 columns) show the crew beside the
chat, with a red dot on a bot whose card is waiting. The key line shows
what fits; /help has the rest. With no bots yet the screen says how to
make the first one. Lists refresh on the server's live signals, never by
polling.

## Line commands

```sh
spriessen ask "summarise yesterday's chats" --bot Wren   # streams the reply; exit 1 if the turn failed
git diff | spriessen ask - --bot Wren --new              # - (or any pipe) reads stdin; --new: a fresh chat
spriessen ask "…" --chat 4b9b                            # continue a chat by (the start of) its id

spriessen bots | bots new <name> [--description …] [--persona …] [--model id] [--quiet] | bots main <name>
spriessen chats [--bot Wren] | chats show [<id>] [--last 3] | chats new [--bot Wren]
spriessen search "invoice last week" [--bot Wren] [--since 2026-11-01] [--who owner|bot]
spriessen memory [--bot Wren] [--find "words"] [--all]   # core lines, then facts by importance
spriessen routines [--bot Wren]                          # schedules, last run, last error
spriessen tasks [--bot Wren] [--all] | tasks show <id> | tasks stop <id>   # running and queued first
spriessen projects [--bot Wren]                          # goals over days, with the next milestone
spriessen models | models default [<id>]                 # * = the workspace default new chats start on
spriessen tests [--bot Wren] | tests run [--bot Wren] [--model kenari/x]

spriessen needs                                          # cards, failed tasks, reviews, parked work
spriessen approve <id> [--always] | deny <id>            # ids (or their start) from `needs`
spriessen approve --all [--yes]                          # shows them, asks, then approves

spriessen open [<chat id>]                               # the web app in your browser (URL printed too)
spriessen completion zsh                                 # eval "$(spriessen completion zsh)" in ~/.zshrc
spriessen version
```

Every list takes `--json` for scripts.

`ask` waits for the turn to settle (`--timeout` seconds, default 600). In
a terminal it plays the turn out live: each tool call as it runs (a "…"
line rewritten with ✓ or ✗ when it ends) and the reply as it is written.
Into a pipe only the reply's words reach stdout (`spriessen ask … >
notes.md` keeps just the text); `--json` prints the entries. If a card
stops it, `ask` prints it on stderr with the command that answers it and
keeps waiting: approve from another terminal, the web or the phone. ctrl-c
leaves the bot working and says which chat the reply will land in. A chat
with no model says how to set the workspace default.

`approve --all` shows the cards it is about to approve and asks first
(`--yes` in a script). Cards that are asked every time on purpose (a
credential's or connector's first use, connector changes, secure inputs)
and scripts reaching past the bot's VM (`host`, `node`) stay waiting for a
look of their own.

`models default <id>` is the same setting as the web's Settings: new chats
start on it at once, and chats that have no model at all (made before any
default existed) take it too. A chat with a model of its own keeps it.

`tests run` replays each saved test on the bot's current setup (or
`--model`), with every tool blocked, and prints each result as it lands: the
checks that failed and Jev's score. It exits 1 when any test fails, so a
script can gate a model or prompt change on it (`--timeout` seconds, default
1800; the run keeps going on the server past it).

Reading is the command line's job; changing memory, routines and bots'
settings stays in the web app, where each change is reviewed.

## Hosting: serve and daemon

`spriessen serve [--port 8787] [--host 127.0.0.1] [--no-web] [--env-file f] [--data dir]`
runs the whole app in one process: the server stack plus the built web app
(`apps/web/dist`, `vp -C apps/web build`). Data goes to `~/.spriessen/data`
(`--data` elsewhere), keys load from `~/.spriessen/.env`, else the source's
`.env`. One server per data folder: a second one is refused by name (two
would run every resumed turn and cron job twice).

`spriessen daemon install [server|node]` keeps `serve` (or `node`) running
under the OS: a systemd `--user` unit on Linux (`loginctl enable-linger
$USER` keeps it running after logout), a launchd agent on macOS (logs in
`~/.spriessen/logs/`). `--port`, `--host` and `--data` are written into the unit. `uninstall`, `start`, `stop`, `restart`,
`status` and `logs` hand over to systemctl/launchctl. No secret is written
into a unit: keys stay in `.env`, the node token in its 0600 file.

## This machine as a node

```sh
spriessen node pair --name laptop --root ~/code --root ~/notes   # signed in; token saved 0600
spriessen node                                                   # run it (or: daemon install node)
spriessen node list | roots laptop --root ~/code | revoke laptop
```

A paired node lets bots run scripts here with bash's `node` target, every
call behind the approval card. Roots are where a script STARTS, not a jail
(docs/SECURITY.md "Paired nodes"). A roots change reaches a running agent
at once; a revoked node's agent stops by itself.
