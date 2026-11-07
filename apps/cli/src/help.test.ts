/**
 * The words around the commands come from one table: every command has a
 * summary and a usage, the overview lists them all, each command's help
 * names its flags, completion offers every command, and "did you mean"
 * catches typos without guessing wildly.
 */
import { describe, expect, it } from "vite-plus/test";
import { parseArgs } from "./args.ts";
import { bashCompletion, fishCompletion } from "./completion.ts";
import { commandHelp, distance, flagProblem, nearest, overview } from "./help.ts";
import { ALL_BOOLEANS, COMMANDS, commandNamed } from "./table.ts";

describe("the command table", () => {
  it("names each command once, with a summary and a usage", () => {
    const names = COMMANDS.map((spec) => spec.name);
    expect(new Set(names).size).toBe(names.length);
    for (const spec of COMMANDS) {
      expect(spec.summary.length).toBeGreaterThan(5);
      expect(spec.usage.length).toBeGreaterThan(0);
      for (const usage of spec.usage) expect(usage.startsWith(spec.name)).toBe(true);
    }
  });

  it("the overview lists every command; a command's help lists its flags", () => {
    const text = overview();
    for (const spec of COMMANDS) expect(text).toContain(`  ${spec.name} `);
    const ask = commandHelp(commandNamed("ask") ?? COMMANDS[0]!);
    expect(ask).toContain("--new");
    expect(ask).toContain("Examples:");
  });

  it("completion offers every command and its second words", () => {
    const bash = bashCompletion();
    for (const spec of COMMANDS) expect(bash).toContain(spec.name);
    expect(bash).toContain('subs="show new"');
    expect(fishCompletion()).toContain('__fish_seen_subcommand_from tasks" -a stop');
  });
});

describe("did you mean", () => {
  it("measures edits and only guesses when close", () => {
    expect(distance("chast", "chats")).toBe(1);
    expect(distance("kitten", "sitting")).toBe(3);
    expect(nearest("chast", ["chats", "bots"])).toBe("chats");
    expect(nearest("sta", ["status", "serve"])).toBe("status");
    expect(nearest("zzzzzz", ["chats", "bots"])).toBeUndefined();
  });

  it("refuses a flag the command does not read, but always takes the global ones", () => {
    const tasks = commandNamed("tasks")!;
    expect(flagProblem(tasks, parseArgs(["tasks", "--all", "--json"], ALL_BOOLEANS))).toBeNull();
    expect(flagProblem(tasks, parseArgs(["tasks", "--al"], ALL_BOOLEANS))).toContain(
      "Did you mean --all?",
    );
  });
});
