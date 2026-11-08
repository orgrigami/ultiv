/**
 * Every `spriessen` command, once: what it does, how it is called, the
 * flags it reads. Dispatch, `--help` (the overview and each command's own),
 * the unknown-flag check, "did you mean" and the shell completion are all
 * read from this table, so they can never disagree. Each command loads its
 * module only when it runs (`bots` never loads the server or OpenTUI).
 */
import type { Parsed } from "./args.ts";

export type Run = (parsed: Parsed, argv: readonly string[]) => Promise<number | void>;

export interface CommandSpec {
  readonly name: string;
  readonly group: Group;
  /** One line for the overview. */
  readonly summary: string;
  /** Call shapes, without the leading `spriessen `. */
  readonly usage: readonly string[];
  /** A few sentences for `spriessen help <name>`. */
  readonly about?: string;
  /** Flag → what it does (`--server`, `--json`, `--help` are always accepted). */
  readonly flags?: Readonly<Record<string, string>>;
  /** Flags that never take a value. */
  readonly booleans?: readonly string[];
  /** Words the second position accepts (for completion). */
  readonly subcommands?: readonly string[];
  readonly examples?: readonly string[];
  /** Talks to a server: a missing sign-in may be fixed in place. */
  readonly client?: boolean;
  readonly run: Run;
}

export type Group = "Talk" | "See" | "Decide" | "Set up" | "Host";
export const GROUPS: readonly Group[] = ["Talk", "See", "Decide", "Set up", "Host"];

export const GLOBAL_FLAGS: Readonly<Record<string, string>> = {
  server: "the server to talk to (default: the saved one, else http://127.0.0.1:8787)",
  json: "print JSON instead of lines (for scripts)",
  help: "show help",
  version: "print the version",
};
export const GLOBAL_BOOLEANS = ["help", "json", "version"];

const BOT = { bot: "a bot: its name, the start of its name, or its id (default: the main bot)" };
const BOT_ALL = { bot: "only this bot (default: every bot)" };

const line = () => import("./commands/line.ts");
const work = () => import("./commands/work.ts");
const look = () => import("./commands/look.ts");
const chatsModule = () => import("./commands/chats.ts");
const botsModule = () => import("./commands/bots.ts");
const setup = () => import("./commands/setup.ts");
const auth = () => import("./commands/auth.ts");

const TALK: readonly CommandSpec[] = [
  {
    name: "chat",
    group: "Talk",
    summary: "open the terminal UI (also: spriessen with no command)",
    usage: ["chat [--bot <name>] [--chat <id>]"],
    about:
      "The chat with a bot, Needs you (tab), the bot picker (ctrl-k) and the chat picker (ctrl-o). Type /help inside for the keys and commands.",
    flags: { ...BOT, chat: "open this chat (an id or its start, from `spriessen chats`)" },
    client: true,
    run: async (parsed) => (await import("./tui-door.ts")).openTui(parsed),
  },
  {
    name: "ask",
    group: "Talk",
    summary: "send one message and print the reply",
    usage: ['ask "message" [--bot <name>] [--chat <id> | --new] [--timeout <s>]', "ask -"],
    about:
      "In a terminal the reply streams in as it is written, with each tool call on its own line. Piped, only the reply's text reaches stdout, so `spriessen ask … > notes.md` keeps just the words. A card that needs you is printed on stderr with the command that answers it, and ask keeps waiting. Exits 1 when the turn failed. ctrl-c leaves the bot working.",
    flags: {
      ...BOT,
      chat: "say it in this chat (an id or its start)",
      new: "say it in a new chat (printed on stderr, to continue with --chat)",
      timeout: "seconds to wait for the reply (default 600)",
    },
    booleans: ["new"],
    examples: [
      'spriessen ask "what is on my calendar today?"',
      "git diff | spriessen ask - --bot Wren --new",
    ],
    client: true,
    run: async (parsed) => (await import("./commands/ask.ts")).ask(parsed),
  },
];

const SEE: readonly CommandSpec[] = [
  {
    name: "bots",
    group: "See",
    summary: "the crew; create a bot or choose the main one",
    usage: [
      "bots",
      'bots new <name> [--description "…"] [--persona "…"] [--model <id>]',
      "bots main <name>",
    ],
    about:
      "The main bot (marked *) is the one `spriessen` and `ask` talk to when you name no bot. A new bot introduces itself in its first chat unless --quiet.",
    flags: {
      description: "what the new bot is for (one line)",
      persona: "how the new bot talks and behaves",
      model: "the new bot's chat model (see `spriessen models`)",
      quiet: "skip the new bot's first hello",
    },
    booleans: ["quiet"],
    subcommands: ["new", "main"],
    client: true,
    run: async (parsed) => (await botsModule()).botsCommand(parsed),
  },
  {
    name: "chats",
    group: "See",
    summary: "past chats; read one; start a new one",
    usage: [
      "chats [--bot <name>] [--limit <n>]",
      "chats show [<id>] [--bot <name>] [--last <n>]",
      "chats new [--bot <name>]",
    ],
    about:
      "`show` prints a chat the way `ask` does (the bot's main chat when no id is given). Ids may be shortened to their first characters.",
    flags: {
      ...BOT_ALL,
      limit: "how many chats to list (default 20)",
      last: "only your last n messages and what followed",
    },
    subcommands: ["show", "new"],
    client: true,
    run: async (parsed) => (await chatsModule()).chatsCommand(parsed),
  },
  {
    name: "search",
    group: "See",
    summary: "search what was said in the bots' chats",
    usage: ['search "words" [--bot <name>] [--since <day>] [--until <day>] [--who owner|bot]'],
    about:
      'A time phrase in the words narrows it too ("invoice last week"). Each hit names its chat; read it with `spriessen chats show <id>`.',
    flags: {
      ...BOT_ALL,
      since: "from this day (YYYY-MM-DD)",
      until: "up to this day (YYYY-MM-DD)",
      who: "only what you said (owner) or what the bot said (bot)",
      limit: "hits per bot (default 10)",
    },
    client: true,
    run: async (parsed) => (await look()).search(parsed),
  },
  {
    name: "memory",
    group: "See",
    summary: "what a bot remembers",
    usage: ['memory [--bot <name>] [--find "words"] [--all]'],
    about:
      "Core lines first (always in the bot's mind), then facts, most important first. Changing memory stays in the web app (Crew › bot › Memory), where every change can be reviewed.",
    flags: {
      ...BOT,
      find: "only facts with these words",
      all: "every fact (default: the 30 most important)",
    },
    booleans: ["all"],
    client: true,
    run: async (parsed) => (await look()).memory(parsed),
  },
  {
    name: "routines",
    group: "See",
    summary: "scheduled wake-ups and when they last ran",
    usage: ["routines [--bot <name>]"],
    flags: BOT_ALL,
    client: true,
    run: async (parsed) => (await look()).routines(parsed),
  },
  {
    name: "tasks",
    group: "See",
    summary: "background work; read one; stop one",
    usage: ["tasks [--bot <name>] [--all]", "tasks show <id>", "tasks stop <id>"],
    flags: { ...BOT_ALL, all: "every task (default: the latest 20)" },
    booleans: ["all"],
    subcommands: ["show", "stop"],
    client: true,
    run: async (parsed) => (await work()).tasksCommand(parsed),
  },
  {
    name: "projects",
    group: "See",
    summary: "goals the bots work on over days",
    usage: ["projects [--bot <name>]"],
    flags: BOT_ALL,
    client: true,
    run: async (parsed) => (await work()).projects(parsed),
  },
  {
    name: "tests",
    group: "See",
    summary: "saved behaviour tests; run exits 1 if any fail",
    usage: ["tests [--bot <name>]", "tests run [--bot <name>] [--model <id>] [--timeout <s>]"],
    about:
      "Save a test with /test in the chat. A run replays each one on the bot's current setup (or --model) with every tool blocked, and grades the reply.",
    flags: {
      ...BOT_ALL,
      model: "replay on this model instead",
      timeout: "seconds to wait (default 1800)",
    },
    subcommands: ["run"],
    client: true,
    run: async (parsed) => (await work()).tests(parsed),
  },
  {
    name: "models",
    group: "See",
    summary: "the models; set the one new chats start on",
    usage: ["models", "models default [<id>]"],
    about:
      "The workspace default (marked *) is the model every chat without one of its own runs on; without it those chats cannot answer. `models default <id>` sets it, the same as Settings in the web app.",
    subcommands: ["default"],
    client: true,
    run: async (parsed) => (await work()).models(parsed),
  },
];

const DECIDE: readonly CommandSpec[] = [
  {
    name: "needs",
    group: "Decide",
    summary: "what is waiting on you: cards, failed tasks, reviews",
    usage: ["needs"],
    client: true,
    run: async (parsed) => (await line()).needs(parsed),
  },
  {
    name: "approve",
    group: "Decide",
    summary: "approve a waiting card",
    usage: ["approve <id> [--always]", "approve --all"],
    flags: {
      always: "also allow it from now on (where the card offers that)",
      all: "approve every waiting card, after showing them (safety floors stay waiting)",
      yes: "with --all: don't ask first",
    },
    booleans: ["always", "all", "yes"],
    client: true,
    run: async (parsed) => (await line()).decide(parsed, true),
  },
  {
    name: "deny",
    group: "Decide",
    summary: "deny a waiting card",
    usage: ["deny <id>"],
    client: true,
    run: async (parsed) => (await line()).decide(parsed, false),
  },
];

const SETUP: readonly CommandSpec[] = [
  {
    name: "login",
    group: "Set up",
    summary: "sign in with the server's passcode",
    usage: ["login [--server <url>]"],
    about:
      "On a fresh install, run on the host itself, this sets the first passcode. The passcode is never stored; the session lasts 30 days from last use.",
    run: async (parsed) => (await auth()).login(parsed),
  },
  {
    name: "logout",
    group: "Set up",
    summary: "sign out (here and on the server)",
    usage: ["logout"],
    run: async (parsed) => (await auth()).logout(parsed),
  },
  {
    name: "status",
    group: "Set up",
    summary: "which server, and whether you are signed in",
    usage: ["status"],
    run: async (parsed) => (await auth()).status(parsed),
  },
  {
    name: "doctor",
    group: "Set up",
    summary: "check everything, and say what to fix",
    usage: ["doctor"],
    about:
      "Walks the path a first run takes: the server answers, a passcode is set, you are signed in, a model provider key is set, a bot exists, the daemon is installed. Each problem comes with the command that fixes it. Exits 1 when something is wrong.",
    run: async (parsed) => (await import("./commands/doctor.ts")).doctor(parsed),
  },
  {
    name: "open",
    group: "Set up",
    summary: "open the web app (or one chat) in the browser",
    usage: ["open [<chat id>]"],
    client: true,
    run: async (parsed) => (await setup()).open(parsed),
  },
  {
    name: "completion",
    group: "Set up",
    summary: "print shell completion (bash, zsh or fish)",
    usage: ["completion <bash|zsh|fish>"],
    about:
      'Add to your shell\'s startup file, e.g. `eval "$(spriessen completion zsh)"` in ~/.zshrc, or `spriessen completion fish > ~/.config/fish/completions/spriessen.fish`.',
    subcommands: ["bash", "zsh", "fish"],
    run: async (parsed) => (await setup()).completion(parsed),
  },
  {
    name: "version",
    group: "Set up",
    summary: "the version and the source it runs from",
    usage: ["version"],
    run: async () => (await setup()).version(),
  },
];

const HOST: readonly CommandSpec[] = [
  {
    name: "serve",
    group: "Host",
    summary: "run the whole app (server + web) here",
    usage: ["serve [--port <n>] [--host <h>] [--no-web] [--env-file <f>] [--data <dir>]"],
    flags: {
      port: "the port (default 8787)",
      host: "the address to listen on (default: every interface)",
      "no-web": "the server only, without the web app",
      web: "serve the web build from this folder",
      "env-file": "load keys from this file (default ~/.spriessen/.env)",
      data: "keep data in this folder (default ~/.spriessen/data)",
    },
    booleans: ["no-web"],
    run: async (parsed) => (await import("./commands/serve.ts")).serveCommand(parsed),
  },
  {
    name: "daemon",
    group: "Host",
    summary: "keep serve (or node) running with the OS",
    usage: ["daemon <install|uninstall|start|stop|restart|status|logs> [server|node]"],
    flags: {
      port: "install: the port",
      host: "install: the address",
      data: "install: the data folder",
      "token-file": "install node: the token file",
    },
    subcommands: ["install", "uninstall", "start", "stop", "restart", "status", "logs"],
    run: async (parsed) => (await import("./commands/daemon.ts")).daemonCommand(parsed),
  },
  {
    name: "node",
    group: "Host",
    summary: "this machine as a paired node for bash",
    usage: [
      "node",
      "node pair --name <name> --root <dir> [--root <dir>…] [--force]",
      "node list | roots <name> --root <dir>… | revoke <name>",
    ],
    flags: {
      name: "pair: this machine's name",
      root: "a folder scripts may start in (repeatable)",
      force: "pair: replace the saved token",
      token: "run: the pairing token (prefer --token-file)",
      "token-file": "run: read the token from this file",
    },
    booleans: ["force"],
    subcommands: ["pair", "list", "roots", "revoke"],
    run: async (parsed, argv) => (await import("./commands/node.ts")).nodeCommand(parsed, argv),
  },
  {
    name: "update",
    group: "Host",
    summary: "pull the checkout, rebuild, restart daemons",
    usage: ["update [--check] [--force]"],
    flags: { check: "only list what is new", force: "rebuild even when already current" },
    booleans: ["check", "force"],
    run: async (parsed) => (await import("./commands/update.ts")).updateCommand(parsed),
  },
  {
    name: "data",
    group: "Host",
    summary: "where everything lives; move an old var/ home",
    usage: ["data", "data move [--from <dir>]"],
    flags: { from: "move: the old data folder" },
    subcommands: ["move"],
    run: async (parsed) => (await import("./commands/data.ts")).dataCommand(parsed),
  },
];

export const COMMANDS: readonly CommandSpec[] = [...TALK, ...SEE, ...DECIDE, ...SETUP, ...HOST];

export const commandNamed = (name: string): CommandSpec | undefined =>
  COMMANDS.find((spec) => spec.name === name);

/** Every flag that never takes a value, across the table (parsing happens before dispatch). */
export const ALL_BOOLEANS: ReadonlySet<string> = new Set([
  ...GLOBAL_BOOLEANS,
  ...COMMANDS.flatMap((spec) => spec.booleans ?? []),
]);
