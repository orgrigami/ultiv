/**
 * The `spriessen` command. With no arguments in a terminal it opens the TUI;
 * every other form is a command. Client commands talk to a server over the
 * same REST + chord surface the web uses; `serve`, `daemon` and `node` run
 * the server or this machine's node agent. Plain TS (erasable syntax only):
 * Node runs it directly; the TUI (TSX) loads on demand through the build or
 * `vpx`.
 */
import { pathToFileURL } from "node:url";
import { parseArgs, type Parsed } from "./args.ts";
import { stringFlag } from "./args.ts";
import { serverOf } from "./config.ts";
import { SignInRequired } from "./client/http.ts";
import { report } from "./errors.ts";

const BOOLEANS = new Set(["help", "json", "always", "no-web", "force", "version", "check"]);

export const HELP = `spriessen — your crew from the terminal

Usage:
  spriessen                         open the terminal UI (chat, Needs you, crew)
  spriessen chat [--bot <name>]     open the terminal UI on one bot's chat
  spriessen ask "…" [--bot <name>] [--chat <id>] [--timeout <s>]
                                    send one message, print the reply
  spriessen bots | chats [--bot <name>] | needs        lists (--json for scripts)
  spriessen approve <id> [--always] | deny <id>         answer a waiting card

  spriessen login | logout | status                     sign in with the passcode
  spriessen serve [--port <n>] [--host <h>] [--no-web] [--env-file <f>]
                                    run the whole app (server + web) here
  spriessen daemon <install|uninstall|start|stop|restart|status|logs> [server|node]
                                    keep serve (or node) running with the OS
  spriessen node [pair|list|revoke|roots]               this machine as a paired node
  spriessen update [--check]                            pull the checkout, rebuild, restart daemons

Every client command takes --server <url> (default: the saved one, else
http://127.0.0.1:8787). Config lives in ~/.config/spriessen (0600).
`;

type Command = (parsed: Parsed, argv: readonly string[]) => Promise<number | void>;

const COMMANDS: Record<string, Command> = {
  login: async (parsed) => (await import("./commands/auth.ts")).login(parsed),
  logout: async (parsed) => (await import("./commands/auth.ts")).logout(parsed),
  status: async (parsed) => (await import("./commands/auth.ts")).status(parsed),
  bots: async (parsed) => (await import("./commands/line.ts")).bots(parsed),
  chats: async (parsed) => (await import("./commands/line.ts")).chats(parsed),
  needs: async (parsed) => (await import("./commands/line.ts")).needs(parsed),
  ask: async (parsed) => (await import("./commands/line.ts")).ask(parsed),
  approve: async (parsed) => (await import("./commands/line.ts")).decide(parsed, true),
  deny: async (parsed) => (await import("./commands/line.ts")).decide(parsed, false),
  serve: async (parsed) => (await import("./commands/serve.ts")).serveCommand(parsed),
  daemon: async (parsed) => (await import("./commands/daemon.ts")).daemonCommand(parsed),
  node: async (parsed, argv) => (await import("./commands/node.ts")).nodeCommand(parsed, argv),
  update: async (parsed) => (await import("./commands/update.ts")).updateCommand(parsed),
  chat: async (parsed) => openTui(parsed),
};

/** The TUI is TSX: it loads through the build (dist) or `vpx`, never plain `node` on the source. */
const openTui = async (parsed: Parsed): Promise<number> => {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error(
      'The terminal UI needs a terminal. Try `spriessen ask "…"` or `spriessen --help`.',
    );
    return 1;
  }
  // Sign-in first, before OpenTUI loads: an unreachable server rejects here
  // and main words it (errors.ts).
  const { apiFor } = await import("./commands/context.ts");
  const api = apiFor(parsed);
  const status = await api.authStatus();
  if (api.cookie === undefined || !status.session) throw new SignInRequired();
  let tui: typeof import("./tui/run.tsx");
  try {
    tui = await import("./tui/run.tsx");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ERR_UNKNOWN_FILE_EXTENSION") throw cause;
    console.error("The terminal UI needs the build first: run `vp -C apps/cli build`.");
    return 1;
  }
  await tui.runTui({ ...api, cookie: api.cookie }, parsed);
  return 0;
};

/** Run one command line; every failure, the UI's included, ends as plain sentences (errors.ts). */
export const main = async (argv: readonly string[]): Promise<number> => {
  let parsed: Parsed | undefined;
  try {
    parsed = parseArgs(argv, BOOLEANS);
    return await dispatch(parsed, argv);
  } catch (cause) {
    report(cause, serverOf(parsed !== undefined ? stringFlag(parsed, "server") : undefined));
    return 1;
  }
};

const dispatch = async (parsed: Parsed, argv: readonly string[]): Promise<number> => {
  const name = parsed.positionals[0];
  if (parsed.flags.get("help") === true || name === "help") {
    console.log(HELP);
    return 0;
  }
  if (name === undefined) {
    if (process.stdout.isTTY) return openTui(parsed);
    console.log(HELP);
    return 0;
  }
  const command = COMMANDS[name];
  if (command === undefined) {
    console.error(
      `There's no \`spriessen ${name}\` command. Run \`spriessen --help\` to see them.`,
    );
    return 1;
  }
  return (await command(parsed, argv)) ?? 0;
};

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const code = await main(process.argv.slice(2));
  // Long-running commands (serve, node) resolve only after their shutdown.
  process.exitCode = code;
}
