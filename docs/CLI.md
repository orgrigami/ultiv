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
spriessen                      # the terminal UI (or open http://127.0.0.1:8787)
```

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

## When something fails

Every command, the UI included, ends a failure with a sentence and the
command that fixes it (not signed in, the server not answering, a wrong
passcode), never a stack trace, and exits 1. `SPRIESSEN_DEBUG=1` adds the
full error underneath.

## The terminal UI

`spriessen` (or `spriessen chat --bot <name>`) opens the chat with the main
bot, or the one you name. One screen, the web's places:

| Key         | Does                                                               |
| ----------- | ------------------------------------------------------------------ |
| enter       | send (while the bot works: steer the running turn)                 |
| ctrl-r      | arm the next send as a redirect (stop and answer this)             |
| esc         | answer the waiting card, else stop the reply                       |
| a / d / A   | on a card: approve / deny / always allow (where the web offers it) |
| i           | leave the card, back to typing                                     |
| ctrl-t      | send messages a failed run left queued (never sent by themselves)  |
| tab         | Needs you ↔ chat (↑/↓ choose, a/d/A decide, enter open its chat)   |
| ctrl-k      | pick a bot                                                         |
| ctrl-n      | a new chat with this bot                                           |
| pgup / pgdn | scroll                                                             |
| ctrl-c      | quit (the terminal is always restored)                             |

Type a slash command into the composer for what the web puts on buttons:

| Command        | Does                                                                     |
| -------------- | ------------------------------------------------------------------------ |
| `/edit [text]` | edit your last message in a new chat (bare `/edit` puts it in the draft) |
| `/branch`      | continue from the bot's last reply in a new chat                         |
| `/test`        | save your last message as a test (`spriessen tests run` replays it)      |
| `/bot <name>`  | switch bots (a name prefix is enough)                                    |
| `/new` `/stop` | a new chat; stop the reply                                               |
| `/help`        | list them; `//text` sends "/text" as a message                           |

The old chat never changes when you branch or edit. Tool calls read in the
web's words (`@spriessen/present`); task results, routine wake-ups, webhooks
and bot mail read as one dim line each (the web's cards, in words), never as
something you typed; a bot's reaction shows as "Wren reacted 👍 Got it".
Thinking stays out of the default view; a card takes the keyboard when it
arrives, unless you are mid-sentence. Wide terminals (≥ 100 columns) show the crew beside
the chat. Lists refresh on the server's live signals, never by polling.

## Line commands

```sh
spriessen ask "summarise yesterday's chats" --bot Wren   # prints the reply; exit 1 if the turn failed
git diff | spriessen ask - --bot Wren                    # - (or any pipe) reads the message from stdin
spriessen bots | chats [--bot Wren] | needs              # --json for scripts
spriessen approve <id> [--always] | deny <id>            # ids from `needs`
spriessen tasks [--bot Wren] [--all]                     # background work, running first, with its model
spriessen projects [--bot Wren]                          # goals over days, with the next milestone
spriessen models                                         # what --model accepts (* = workspace default)
spriessen tests [--bot Wren]                             # saved tests (/test in the TUI, or the web)
spriessen tests run [--bot Wren] [--model kenari/x]      # replay them; exit 1 if any fail
```

`tests run` replays each saved test on the bot's current setup (or
`--model`), with every tool blocked, and prints each result as it lands: the
checks that failed and Jev's score. It exits 1 when any test fails, so a
script can gate a model or prompt change on it (`--timeout` seconds, default
1800; the run keeps going on the server past it).

`ask` waits for the turn to settle (`--timeout` seconds, default 600). If a
card stops it, `ask` prints it with the command that answers it and keeps
waiting: approve from another terminal, the web or the phone.

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
