/**
 * The `spriessen` command. With no arguments in a terminal it opens the TUI;
 * every other form is a command from the table (table.ts), which also
 * drives the help, the flag check and completion. A command that finds you
 * signed out, in a terminal, asks for the passcode right there and goes on
 * (scripts and `--json` get the sentence instead). Plain TS (erasable syntax
 * only): Node runs it directly; the TUI (TSX) loads on demand through the
 * build or `vpx`.
 */
import { pathToFileURL } from "node:url";
import { parseArgs, stringFlag, type Parsed } from "./args.ts";
import { serverOf } from "./config.ts";
import { SignInRequired } from "./client/http.ts";
import { report } from "./errors.ts";
import { commandHelp, flagProblem, overview, unknownCommand } from "./help.ts";
import { ALL_BOOLEANS, commandNamed, type CommandSpec } from "./table.ts";

/** Kept for the tests and anything that printed it before the table. */
export const HELP = overview();

/** Run one command line; every failure, the UI's included, ends as plain sentences (errors.ts). */
export const main = async (argv: readonly string[]): Promise<number> => {
  let parsed: Parsed | undefined;
  try {
    parsed = parseArgs(argv, ALL_BOOLEANS);
    return await dispatch(parsed, argv);
  } catch (cause) {
    report(cause, serverOf(parsed !== undefined ? stringFlag(parsed, "server") : undefined));
    return 1;
  }
};

const dispatch = async (parsed: Parsed, argv: readonly string[]): Promise<number> => {
  const [first, second] = parsed.positionals;
  if (parsed.flags.get("version") === true && first === undefined) {
    return run(commandNamed("version") as CommandSpec, parsed, argv);
  }
  if (first === "help" || (first === undefined && parsed.flags.get("help") === true)) {
    const spec = second !== undefined ? commandNamed(second) : undefined;
    if (second !== undefined && spec === undefined) {
      console.error(unknownCommand(second));
      return 1;
    }
    console.log(spec !== undefined ? commandHelp(spec) : overview());
    return 0;
  }
  if (first === undefined) {
    if (process.stdout.isTTY) return run(commandNamed("chat") as CommandSpec, parsed, argv);
    console.log(overview());
    return 0;
  }
  const spec = commandNamed(first);
  if (spec === undefined) {
    console.error(unknownCommand(first));
    return 1;
  }
  if (parsed.flags.get("help") === true) {
    console.log(commandHelp(spec));
    return 0;
  }
  const problem = flagProblem(spec, parsed);
  if (problem !== null) {
    console.error(problem);
    return 1;
  }
  return run(spec, parsed, argv);
};

/** In a terminal, with a person at it: a missing sign-in can be fixed in place. */
const canAsk = (parsed: Parsed): boolean =>
  process.stdin.isTTY === true &&
  process.stderr.isTTY === true &&
  parsed.flags.get("json") !== true;

const run = async (spec: CommandSpec, parsed: Parsed, argv: readonly string[]): Promise<number> => {
  try {
    return (await spec.run(parsed, argv)) ?? 0;
  } catch (cause) {
    if (!(cause instanceof SignInRequired) || spec.client !== true || !canAsk(parsed)) throw cause;
    const { signInHere } = await import("./commands/auth.ts");
    await signInHere(serverOf(stringFlag(parsed, "server")), "You're not signed in yet.");
    return (await spec.run(parsed, argv)) ?? 0;
  }
};

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const code = await main(process.argv.slice(2));
  // Long-running commands (serve, node) resolve only after their shutdown.
  process.exitCode = code;
}
