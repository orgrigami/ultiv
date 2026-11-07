/**
 * The words around the commands, read from the table (table.ts): the
 * overview `spriessen --help` prints, each command's own help, the refusal
 * for a flag a command does not read (with the nearest real one), and
 * "did you mean" for a mistyped command.
 */
import type { Parsed } from "./args.ts";
import { COMMANDS, GLOBAL_FLAGS, GROUPS, type CommandSpec } from "./table.ts";

/** Edit distance where swapping two neighbours is one edit ("chast" → "chats"). */
export const distance = (a: string, b: string): number => {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  const at = (i: number, j: number): number => d[i]?.[j] ?? 0;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, at(i - 2, j - 2) + 1);
      }
      (d[i] as number[])[j] = best;
    }
  }
  return at(a.length, b.length);
};

/** The closest of `options` to `word`, when it is close enough to be a typo. */
export const nearest = (word: string, options: readonly string[]): string | undefined => {
  const prefixed = options.filter((option) => option.startsWith(word) && word.length >= 2);
  if (prefixed.length === 1) return prefixed[0];
  let best: { option: string; score: number } | undefined;
  for (const option of options) {
    const score = distance(word, option);
    if (best === undefined || score < best.score) best = { option, score };
  }
  return best !== undefined && best.score <= Math.max(1, Math.floor(word.length / 3))
    ? best.option
    : undefined;
};

export const unknownCommand = (name: string): string => {
  const guess = nearest(
    name,
    COMMANDS.map((spec) => spec.name),
  );
  return (
    `There's no \`spriessen ${name}\` command.` +
    (guess !== undefined ? ` Did you mean \`spriessen ${guess}\`?` : "") +
    "\nRun `spriessen --help` to see them all."
  );
};

/** A flag the command does not read, worded with the nearest one it does; null when all are fine. */
export const flagProblem = (spec: CommandSpec, parsed: Parsed): string | null => {
  const known = [...Object.keys(spec.flags ?? {}), ...Object.keys(GLOBAL_FLAGS)];
  for (const flag of parsed.flags.keys()) {
    if (known.includes(flag)) continue;
    const guess = nearest(flag, known);
    return (
      `\`spriessen ${spec.name}\` has no --${flag} flag.` +
      (guess !== undefined ? ` Did you mean --${guess}?` : "") +
      `\nRun \`spriessen ${spec.name} --help\` for its flags.`
    );
  }
  return null;
};

const pad = (text: string, width: number): string => text.padEnd(width);

/** A paragraph broken into lines of at most `width` characters. */
export const wrap = (text: string, width = 76): string[] => {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line !== "" && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line === "" ? word : `${line} ${word}`;
  }
  if (line !== "") lines.push(line);
  return lines;
};

/** `spriessen --help`. */
export const overview = (): string => {
  const width = Math.max(...COMMANDS.map((spec) => spec.name.length)) + 2;
  const sections = GROUPS.map((group) => {
    const rows = COMMANDS.filter((spec) => spec.group === group).map(
      (spec) => `  ${pad(spec.name, width)}${spec.summary}`,
    );
    return `${group}:\n${rows.join("\n")}`;
  });
  return [
    "spriessen — your crew from the terminal",
    "",
    "Usage: spriessen [command] [flags]",
    "       spriessen            open the chat (the terminal UI)",
    "",
    ...sections.flatMap((section) => [section, ""]),
    "Every command that talks to a server takes --server <url> and --json.",
    "`spriessen help <command>` (or `<command> --help`) shows its flags and examples.",
    "New here? Run `spriessen doctor`. Everything lives in ~/.spriessen ($SPRIESSEN_HOME).",
  ].join("\n");
};

const flagRows = (flags: Readonly<Record<string, string>>): string[] => {
  const entries = Object.entries(flags);
  const width = Math.max(...entries.map(([name]) => name.length)) + 4;
  return entries.map(([name, text]) => `  ${pad(`--${name}`, width)}${text}`);
};

/** `spriessen help <name>` / `spriessen <name> --help`. */
export const commandHelp = (spec: CommandSpec): string => {
  const lines = [`spriessen ${spec.name} — ${spec.summary}`, "", "Usage:"];
  for (const usage of spec.usage) lines.push(`  spriessen ${usage}`);
  if (spec.about !== undefined) lines.push("", ...wrap(spec.about));
  if (spec.flags !== undefined && Object.keys(spec.flags).length > 0) {
    lines.push("", "Flags:", ...flagRows(spec.flags));
  }
  if (spec.client === true) lines.push("", "Also: --server <url>, --json.");
  if (spec.examples !== undefined) {
    lines.push("", "Examples:", ...spec.examples.map((example) => `  ${example}`));
  }
  return lines.join("\n");
};
