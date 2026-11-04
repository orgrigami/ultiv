/**
 * The command line, parsed once: positionals in order, `--name value`,
 * `--name=value`, bare `--flag` booleans, and `-h`. A flag listed in
 * `booleans` never swallows the next word. No dependency: the surface is
 * small and every command reads its own flags.
 */
export interface Parsed {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}

export const parseArgs = (argv: readonly string[], booleans: ReadonlySet<string>): Parsed => {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index] ?? "";
    if (word === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (word === "-h") {
      flags.set("help", true);
      continue;
    }
    if (!word.startsWith("--") || word === "--") {
      positionals.push(word);
      continue;
    }
    const eq = word.indexOf("=");
    if (eq > 2) {
      flags.set(word.slice(2, eq), word.slice(eq + 1));
      continue;
    }
    const name = word.slice(2);
    const next = argv[index + 1];
    if (booleans.has(name) || next === undefined || next.startsWith("--")) {
      flags.set(name, true);
      continue;
    }
    flags.set(name, next);
    index += 1;
  }
  return { positionals, flags };
};

/** A string flag, or undefined (a bare boolean flag reads as missing). */
export const stringFlag = (parsed: Parsed, name: string): string | undefined => {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
};

export const boolFlag = (parsed: Parsed, name: string): boolean => parsed.flags.get(name) === true;

/** Every value of a repeatable flag (`--root a --root b`), in order. */
export const allFlags = (argv: readonly string[], name: string): string[] => {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index] ?? "";
    if (word === `--${name}` && argv[index + 1] !== undefined) values.push(argv[index + 1] ?? "");
    else if (word.startsWith(`--${name}=`)) values.push(word.slice(name.length + 3));
  }
  return values;
};

export const numberFlag = (parsed: Parsed, name: string): number | undefined => {
  const value = stringFlag(parsed, name);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`--${name} must be a number`);
  return number;
};
