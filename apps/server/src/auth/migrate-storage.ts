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
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { artifactsDir, mcpDir, vaultDir } from "@spriessen/ext";
import { botFilesDir, skillsDir } from "@spriessen/mind";
import { pushDir } from "../push/config.ts";

export interface StorageReport {
  folders: string[];
  sidecars: number;
  pushEntries: number;
  /** MCP server records and vault items whose stored owner was relabeled. */
  records: number;
  /** Files left under the old label because the account already had one. */
  conflicts: string[];
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
  to: string,
): { readonly base: string; readonly name: string }[] => {
  const found: { base: string; name: string }[] = [];
  for (const base of bases) {
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      if (name === to || name === "agent" || name.startsWith(".")) continue;
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

/** An owner label that moves to the account; `agent` (bot-owned) never does. */
const movable = (owner: unknown, to: string): owner is string =>
  typeof owner === "string" && owner.trim() !== "" && owner !== to && owner !== "agent";

const readJsonFile = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
};

const writeJsonFile = (path: string, value: unknown, pretty = false): void => {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value), {
    mode: 0o600,
  });
  renameSync(tmp, path);
};

interface McpRecordShape {
  readonly id?: unknown;
  owner?: unknown;
}

/**
 * Two servers.json files for one account: keep every target record and add
 * the source's records whose id the target lacks, so no connector is lost.
 */
const mergeServers = (source: string, target: string): boolean => {
  const from = readJsonFile<McpRecordShape[]>(source);
  const into = readJsonFile<McpRecordShape[]>(target);
  if (!Array.isArray(from) || !Array.isArray(into)) return false;
  const ids = new Set(into.map((row) => row.id));
  writeJsonFile(target, [...into, ...from.filter((row) => !ids.has(row.id))], true);
  rmSync(source);
  return true;
};

/** Move {base}/{old} to {base}/{to}, merging into an existing target. */
const moveFolder = (
  base: string,
  oldName: string,
  to: string,
  moves: string[],
  conflicts: string[],
): void => {
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
  mergeInto(from, target, conflicts);
  try {
    rmSyncDirIfEmpty(from);
  } catch {
    // A non-empty source (collisions kept) stays put.
  }
  moves.push(`${from} merged into ${target}`);
};

const mergeInto = (from: string, target: string, conflicts: string[]): void => {
  for (const entry of readdirSync(from)) {
    const source = join(from, entry);
    const targetPath = join(target, entry);
    if (
      statSync(source).isDirectory() &&
      existsSync(targetPath) &&
      statSync(targetPath).isDirectory()
    ) {
      mergeInto(source, targetPath, conflicts);
      continue;
    }
    if (existsSync(targetPath)) {
      if (entry === "servers.json" && mergeServers(source, targetPath)) continue;
      conflicts.push(source);
      continue;
    }
    renameSync(source, targetPath);
  }
};

/**
 * Artifact sidecars carry the owner inside; relabel the ones a migrated label
 * owns. Bot-owned (`agent`) and unowned sidecars keep their owner.
 */
const relabelSidecars = (root: string, to: string, from: readonly string[]): number => {
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
        if (!movable(parsed.owner, to)) continue;
        if (from.length > 0 && !from.includes(parsed.owner)) continue;
        parsed.owner = to;
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
  const report: StorageReport = {
    folders: [],
    sidecars: 0,
    pushEntries: 0,
    records: 0,
    conflicts: [],
    moves: [],
  };
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
  const found = withFrom(ownerFolders(bases, options.to), options.from ?? []);
  if (options.dryRun === true) {
    report.folders = found.map((move) => `${move.base}/${move.name}`);
    report.moves = report.folders;
    return report;
  }
  const moves: string[] = [];
  for (const move of found) {
    moveFolder(move.base, move.name, options.to, moves, report.conflicts);
  }
  report.folders = moves;
  report.moves = moves;
  const from = options.from ?? [];
  const artifactRoot = options.dirs?.artifacts ?? artifactsDir();
  const pushRoot = options.dirs?.push ?? pushDir();
  if (existsSync(artifactRoot)) {
    report.sidecars = relabelSidecars(artifactRoot, options.to, from);
  }
  report.records =
    relabelMcpRecords(options.dirs?.mcp ?? mcpDir(), options.to) +
    relabelVaultItems(options.dirs?.vault ?? vaultDir(), options.to);
  report.pushEntries = migratePush(pushRoot, options.to, from);
  return report;
};

/**
 * MCP server records store their owner, and the connector access check
 * compares it with the caller: a moved record keeping its old label would
 * leave the connector unusable. Relabel the account's records.
 */
const relabelMcpRecords = (root: string, to: string): number => {
  const file = join(root, to, "servers.json");
  const rows = existsSync(file) ? readJsonFile<McpRecordShape[]>(file) : undefined;
  if (!Array.isArray(rows)) return 0;
  let count = 0;
  for (const row of rows) {
    if (movable(row.owner, to)) {
      row.owner = to;
      count += 1;
    }
  }
  if (count > 0) writeJsonFile(file, rows, true);
  return count;
};

/** Vault item sidecars carry `info.owner`; keep it in step with the folder. */
const relabelVaultItems = (root: string, to: string): number => {
  const dir = join(root, to, "items");
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const path = join(dir, entry);
    const item = readJsonFile<{ info?: { owner?: unknown } }>(path);
    if (item?.info === undefined || !movable(item.info.owner, to)) continue;
    item.info.owner = to;
    writeJsonFile(path, item);
    count += 1;
  }
  return count;
};

/** Move the per-owner arrays inside subscriptions.json. */
const migratePush = (dir: string, to: string, from: readonly string[]): number => {
  const file = join(dir, "subscriptions.json");
  if (!existsSync(file)) return 0;
  try {
    const shape = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown[]>;
    let moved = 0;
    for (const key of Object.keys(shape)) {
      if (!movable(key, to)) continue;
      if (from.length > 0 && !from.includes(key)) continue;
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
