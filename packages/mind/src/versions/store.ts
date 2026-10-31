/**
 * The version store: one JSON file per versioned text (a bot's Persona or
 * Instructions, a skill body), holding its full history. The last entry is
 * the current text. Saves append, and restore appends a copy of the old
 * version, so history is never rewritten. Files sit under a caller-given
 * folder and go through the shared confinement helper; every write lands in
 * a temp file that is renamed into place, so a crash never leaves half a file.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isSafeSegment, resolveInside } from "@spreissen/core";

/** Who or what saved a version. */
export type VersionAuthor = "owner" | "bot" | "migration" | "learning";

export interface Version {
  /** 1-based and increasing (contiguous unless a caller pins `n`, as skills do). */
  readonly n: number;
  readonly text: string;
  readonly at: number;
  readonly by: VersionAuthor;
  /** One line, at most REASON_CHARS. */
  readonly reason: string;
  /** The turn (conversation and step) a learned version came from. */
  readonly turn?: string;
  /** Set when this version restores an older one. */
  readonly restoredFrom?: number;
}

export interface SaveMeta {
  readonly by: VersionAuthor;
  readonly reason: string;
  readonly turn?: string;
  readonly restoredFrom?: number;
  /** Pin the number (never below the next one): skills keep their existing version count. */
  readonly n?: number;
}

export const REASON_CHARS = 140;

const oneLine = (text: string): string =>
  text.replace(/\s+/g, " ").trim().slice(0, REASON_CHARS) || "Saved";

const fileOf = (dir: string, name: string): string => {
  if (!isSafeSegment(name)) throw new Error(`bad version name "${name.slice(0, 64)}"`);
  return resolveInside(dir, `${name}.versions.json`);
};

const isVersion = (value: unknown): value is Version =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Version).n === "number" &&
  typeof (value as Version).text === "string";

/** The full history, oldest first; empty when nothing was ever saved. */
export const historyOf = (dir: string, name: string): Version[] => {
  const file = fileOf(dir, name);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { versions?: unknown };
    return Array.isArray(parsed.versions) ? parsed.versions.filter(isVersion) : [];
  } catch {
    return [];
  }
};

export const currentOf = (dir: string, name: string): Version | undefined =>
  historyOf(dir, name).at(-1);

const writeAll = (file: string, versions: readonly Version[]): void => {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ versions }, null, 1)}\n`);
  renameSync(temp, file);
};

/** Append a version and return it. */
export const appendVersion = (
  dir: string,
  name: string,
  text: string,
  meta: SaveMeta,
  now: number = Date.now(),
): Version => {
  const file = fileOf(dir, name);
  const versions = historyOf(dir, name);
  const version: Version = {
    n: Math.max((versions.at(-1)?.n ?? 0) + 1, meta.n ?? 0),
    text,
    at: now,
    by: meta.by,
    reason: oneLine(meta.reason),
    ...(meta.turn !== undefined ? { turn: meta.turn.slice(0, 200) } : {}),
    ...(meta.restoredFrom !== undefined ? { restoredFrom: meta.restoredFrom } : {}),
  };
  writeAll(file, [...versions, version]);
  return version;
};

/**
 * Save unless the text equals the current version (no empty versions from a
 * dialog that saved nothing new). Returns the version written, or undefined.
 */
export const saveIfChanged = (
  dir: string,
  name: string,
  text: string,
  meta: SaveMeta,
): Version | undefined =>
  currentOf(dir, name)?.text === text ? undefined : appendVersion(dir, name, text, meta);

/** Make version `n` current again by appending a copy of it. Undefined when `n` is unknown. */
export const restoreVersion = (
  dir: string,
  name: string,
  n: number,
  by: VersionAuthor,
): Version | undefined => {
  const old = historyOf(dir, name).find((version) => version.n === n);
  if (old === undefined) return undefined;
  return appendVersion(dir, name, old.text, {
    by,
    reason: `Restored version ${n}`,
    restoredFrom: n,
  });
};
