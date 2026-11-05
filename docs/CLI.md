# The `spriessen` command

A terminal client and host for the same app the web runs: the same server,
the same bots, the same approval cards. It talks to a server over the
surfaces the web uses (REST, the chord `Session` object, the `/push` live
signals), so nothing a bot does differs by client. Code: `apps/cli`.

## Installing

From a checkout of the repo, with [Vite+](https://viteplus.dev) (`vp`) installed:

```sh
sh scripts/install-cli.sh             # into ~/.local/bin (--prefix <dir> for elsewhere)
spriessen login                       # once per server
spriessen                             # the terminal UI
```

The script syncs dependencies, builds the web app and the CLI, and writes a
small `spriessen` launcher that runs with the repo's own Node (the one `vp
node` resolves), never whatever `node` is first on PATH. Re-run it after a
`git pull` to update; `--uninstall` removes the launcher (your sign-in in
`~/.config/spriessen` stays).

Without installing: `vp -C apps/cli build`, then `vp node
apps/cli/bin/spriessen.mjs …`; or, unbuilt, `vp node apps/cli/src/main.ts …`
for every command except the UI (`vpx apps/cli/src/main.ts` runs the UI
from source).

## Signing in

`spriessen login [--server <url>]` asks for the server's passcode (no echo;
piped input works for scripts) and keeps the session cookie the web's own
sign-in returns in `~/.config/spriessen/credentials.json` (0600, folder
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

Tool calls read in the web's words (`@spriessen/present`); thinking stays
out of the default view; a card takes the keyboard when it arrives, unless
you are mid-sentence. Wide terminals (≥ 100 columns) show the crew beside
the chat. Lists refresh on the server's live signals, never by polling.

## Line commands

```sh
spriessen ask "summarise yesterday's chats" --bot Wren   # prints the reply; exit 1 if the turn failed
spriessen bots | chats [--bot Wren] | needs              # --json for scripts
spriessen approve <id> [--always] | deny <id>            # ids from `needs`
```

`ask` waits for the turn to settle (`--timeout` seconds, default 600). If a
card stops it, `ask` prints it with the command that answers it and keeps
waiting: approve from another terminal, the web or the phone.

## Hosting: serve and daemon

`spriessen serve [--port 8787] [--host 127.0.0.1] [--no-web] [--env-file f] [--data dir]`
runs the whole app in one process: the server stack plus the built web app
(`apps/web/dist`, `vp -C apps/web build`). It runs from the server's own
folder, so `var/` is the same data folder the dev server uses, and the
repo's `.env` loads first. One server per data folder: a second one is
refused by name (two would run every resumed turn and cron job twice).

`spriessen daemon install [server|node]` keeps `serve` (or `node`) running
under the OS: a systemd `--user` unit on Linux (`loginctl enable-linger
$USER` keeps it running after logout), a launchd agent on macOS (logs in
`~/Library/Logs/spriessen-*.log`). `uninstall`, `start`, `stop`, `restart`,
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
