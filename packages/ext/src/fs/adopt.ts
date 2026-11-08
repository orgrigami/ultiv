/**
 * One-time, repeatable: files written before every writer went through the
 * tree (artifact_write, uploads, screenshots, grants) sit in a bot's store
 * with no path. Adoption places each at a path in the tree:
 *
 * - text files of one name are one file: the newest is placed at the name,
 *   the older ones become its earlier versions (still readable by id, so old
 *   chat cards keep their content; never pruned here);
 * - anything else (images, PDFs) is placed at its name, or a free numbered
 *   variant when the name is taken — two uploads called image.png are two
 *   different pictures.
 *
 * Tree files whose sidecar predates `path` get it stamped. Nothing is
 * deleted. Runs at server boot over every bot's store; a store with nothing
 * loose changes nothing.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { ArtifactInfo } from "@spriessen/contracts";
import { tryResolveInside } from "@spriessen/core";
import { allSidecars, VFS_INDEX_ID } from "../plugins/artifacts.ts";
import { DurableFs } from "./durable-fs.ts";
import type { VfsIndex } from "./durable-fs-shapes.ts";
import { blobPath, restamp } from "./durable-store.ts";
import { freePath, pathForName } from "./tree.ts";
import { addVersion } from "./versions.ts";
import { bumpWorkspace } from "./workspace-epoch.ts";

const textual = (mime: string): boolean => mime.startsWith("text/") || mime === "application/json";

/** The index as stored ({} when there is none yet). */
const indexOf = (dir: string): VfsIndex["paths"] => {
  try {
    return (JSON.parse(readFileSync(blobPath(dir, VFS_INDEX_ID), "utf8")) as VfsIndex).paths;
  } catch {
    return {};
  }
};

/** Loose files grouped by where they go: one group per text name, one per other file. */
const groupsOf = (loose: readonly ArtifactInfo[]): readonly (readonly ArtifactInfo[])[] => {
  const byPath = new Map<string, ArtifactInfo[]>();
  const single: ArtifactInfo[][] = [];
  for (const info of [...loose].sort((a, b) => a.createdAt - b.createdAt)) {
    if (!textual(info.mime)) {
      single.push([info]);
      continue;
    }
    const path = pathForName("", info.name, info.id);
    byPath.set(path, [...(byPath.get(path) ?? []), info]);
  }
  return [...byPath.values(), ...single];
};

/** Adopt one store's loose files; returns how many files were placed or versioned. */
export const adoptLooseFiles = async (dir: string): Promise<number> => {
  if (!existsSync(dir)) return 0;
  const paths = indexOf(dir);
  const placed = new Set<string>();
  for (const entry of Object.values(paths)) {
    if (entry.kind === "file" && entry.id !== undefined) placed.add(entry.id);
  }
  const sidecars = allSidecars(dir);
  const loose = sidecars.filter((info) => !placed.has(info.id) && info.versionOf === undefined);
  for (const info of sidecars) {
    const at = Object.entries(paths).find(([, entry]) => entry.id === info.id)?.[0];
    if (at !== undefined && info.path === undefined) restamp(dir, info.id, at);
  }
  if (loose.length === 0) return 0;
  const fs = new DurableFs({ dir });
  for (const group of groupsOf(loose)) {
    const head = group[group.length - 1] as ArtifactInfo;
    fs.place(await freePath(fs, pathForName("", head.name, head.id)), head.id);
    for (const older of group.slice(0, -1)) addVersion(dir, head.id, older.id, false);
  }
  bumpWorkspace(dir);
  return loose.length;
};

const subdirs = (dir: string): readonly string[] => {
  try {
    return readdirSync(dir).flatMap((name) => {
      const path = tryResolveInside(dir, name);
      return path !== undefined && statSync(path).isDirectory() ? [path] : [];
    });
  } catch {
    return [];
  }
};

/**
 * Every bot store under the root: {owner}/{profile} and the team stores
 * {owner}/_team/{id}. Other `_` folders (the home VMs' scope) hold no files;
 * the legacy root stays loose.
 */
export const adoptAllLooseFiles = async (root: string): Promise<number> => {
  let total = 0;
  for (const owner of subdirs(root)) {
    for (const store of subdirs(owner)) {
      const name = basename(store);
      const stores = name === "_team" ? subdirs(store) : name.startsWith("_") ? [] : [store];
      for (const dir of stores) total += await adoptLooseFiles(dir);
    }
  }
  return total;
};
