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
import { ApiError, SignInRequired } from "./client/http.ts";

const BOOLEANS = new Set(["help", "json", "always", "no-web", "force", "version"]);

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
  chat: async (parsed) => openTui(parsed),
};

/** The TUI is TSX: it loads through the build (dist) or `vpx`, never plain `node` on the source. */
const openTui = async (parsed: Parsed): Promise<number> => {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error("the terminal UI needs a terminal; try `spriessen ask` or `--help`");
    return 1;
  }
  let tui: typeof import("./tui/run.tsx");
  try {
    tui = await import("./tui/run.tsx");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ERR_UNKNOWN_FILE_EXTENSION") throw cause;
    console.error("the terminal UI needs the build: vp -C apps/cli build (or run it with vpx)");
    return 1;
  }
  await tui.runTui(parsed);
  return 0;
};

export const main = async (argv: readonly string[]): Promise<number> => {
  const parsed = parseArgs(argv, BOOLEANS);
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
    console.error(`unknown command: ${name}\n\n${HELP}`);
    return 1;
  }
  try {
    return (await command(parsed, argv)) ?? 0;
  } catch (cause) {
    if (cause instanceof SignInRequired) console.error(cause.message);
    else if (cause instanceof ApiError) console.error(`spriessen: ${cause.message}`);
    else console.error(`spriessen: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 1;
  }
};

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const code = await main(process.argv.slice(2));
  // Long-running commands (serve, node) resolve only after their shutdown.
  process.exitCode = code;
}
