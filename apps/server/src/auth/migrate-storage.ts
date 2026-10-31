/**
 * The storage half of the owner migration: the per-owner folders (artifacts,
 * skills, bot files, MCP work dirs, vault) and the per-owner fields in flat
 * files (artifact sidecars, push subscriptions). The mind-side doc moves run
 * in @spriessen/mind's migrateOwners; this module moves what lives on disk.
 * Repeatable, and a dry run reports without touching anything.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { artifactsDir, mcpDir, vaultDir } from "@spriessen/ext";
import { botFilesDir, skillsDir } from "@spriessen/mind";
import { OWNER_ID } from "../identity.ts";
import { pushDir } from "../push/config.ts";

export interface StorageReport {
  folders: string[];
  sidecars: number;
  pushEntries: number;
  /** What a dry run WOULD move (or what moved, on a real run). */
  moves: string[];
}

export interface StorageOptions {
  readonly to: string;
  /** Labels known from the docs half; folders sweep for the rest. */
  readonly from?: readonly string[];
  readonly dryRun?: boolean;
  /** Test seam: explicit bases instead of the environment's. */
  readonly dirs?: {
    readonly artifacts: string;
    readonly skills: string;
    readonly botFiles: string;
    readonly mcp: string;
    readonly vault: string;
    readonly push: string;
  };
}

/** Every {base}/{old} folder that belongs to a label other than the account. */
const ownerFolders = (
  bases: readonly string[],
): { readonly base: string; readonly name: string }[] => {
  const found: { base: string; name: string }[] = [];
  for (const base of bases) {
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      if (name === OWNER_ID || name === "agent" || name.startsWith(".")) continue;
      try {
        if (statSync(join(base, name)).isDirectory()) found.push({ base, name });
      } catch {
        // A raced deletion is not a migration problem.
      }
    }
  }
  return found;
};

const withFrom = (
  moves: { readonly base: string; readonly name: string }[],
  from: readonly string[],
): { base: string; name: string }[] =>
  moves.filter((move) => from.length === 0 || from.includes(move.name));

const rmSyncDirIfEmpty = (dir: string): void => {
  if (readdirSync(dir).length === 0) rmdirSync(dir);
};

/** Move {base}/{old} to {base}/{to}, merging into an existing target. */
const moveFolder = (base: string, oldName: string, to: string, moves: string[]): void => {
  const from = join(base, oldName);
  const target = join(base, to);
  if (!existsSync(from)) return;
  if (!existsSync(target)) {
    renameSync(from, target);
    moves.push(`${from} -> ${target}`);
    return;
  }
  // Both exist: keep the target's files on collision, move the rest (walking
  // into colliding folders), and take the emptied source with it so the next
  // run finds nothing.
  mergeInto(from, target);
  try {
    rmSyncDirIfEmpty(from);
  } catch {
    // A non-empty source (collisions kept) stays put.
  }
  moves.push(`${from} merged into ${target}`);
};

const mergeInto = (from: string, target: string): void => {
  for (const entry of readdirSync(from)) {
    const source = join(from, entry);
    const targetPath = join(target, entry);
    if (statSync(source).isDirectory() && existsSync(targetPath) && statSync(targetPath).isDirectory()) {
      mergeInto(source, targetPath);
      continue;
    }
    if (existsSync(targetPath)) continue;
    renameSync(source, targetPath);
  }
};

/** Artifact sidecars carry the owner inside; relabel them after the move. */
const relabelSidecars = (root: string): number => {
  let count = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = readFileSync(path, "utf8");
        const parsed = JSON.parse(raw) as { owner?: string | null };
        if (parsed.owner === OWNER_ID) continue;
        parsed.owner = OWNER_ID;
        writeFileSync(path, JSON.stringify(parsed), { mode: 0o600 });
        count += 1;
      } catch {
        // An unreadable sidecar is left alone; the blob stays readable.
      }
    }
  };
  walk(root);
  return count;
};

export const migrateStorage = (options: StorageOptions): StorageReport => {
  const report: StorageReport = { folders: [], sidecars: 0, pushEntries: 0, moves: [] };
  const bases =
    options.dirs !== undefined
      ? [
          options.dirs.artifacts,
          options.dirs.skills,
          options.dirs.botFiles,
          options.dirs.mcp,
          options.dirs.vault,
          options.dirs.push,
        ]
      : [artifactsDir(), skillsDir(), botFilesDir(), mcpDir(), vaultDir(), pushDir()];
  const found = withFrom(ownerFolders(bases), options.from ?? []);
  if (options.dryRun === true) {
    report.folders = found.map((move) => `${move.base}/${move.name}`);
    report.moves = report.folders;
    return report;
  }
  const moves: string[] = [];
  for (const move of found) moveFolder(move.base, move.name, options.to, moves);
  report.folders = moves;
  report.moves = moves;
  const artifactRoot = options.dirs?.artifacts ?? artifactsDir();
  const pushRoot = options.dirs?.push ?? pushDir();
  if (existsSync(artifactRoot)) report.sidecars = relabelSidecars(artifactRoot);
  report.pushEntries = migratePush(pushRoot, options.to);
  return report;
};

/** Move the per-owner arrays inside subscriptions.json. */
const migratePush = (dir: string, to: string): number => {
  const file = join(dir, "subscriptions.json");
  if (!existsSync(file)) return 0;
  try {
    const shape = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown[]>;
    let moved = 0;
    for (const key of Object.keys(shape)) {
      if (key === to || key === "agent" || key === "") continue;
      const rows = shape[key];
      if (!Array.isArray(rows)) continue;
      const target = shape[to] ?? [];
      shape[to] = [...target, ...(rows as unknown[])];
      delete shape[key];
      moved += rows.length;
    }
    if (moved > 0) {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(shape), { mode: 0o600 });
      renameSync(tmp, file);
    }
    return moved;
  } catch {
    return 0;
  }
};
