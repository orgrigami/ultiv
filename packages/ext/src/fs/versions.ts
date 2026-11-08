/**
 * Earlier versions of a tree file. Overwriting a file at its path keeps the
 * bytes it had as a version: its own blob + sidecar (a fresh id, `versionOf`
 * the head), hidden from every file list but still readable by id, so a
 * chat card that showed that content keeps working. The head's version ids
 * live newest-first in `<id>.versions.json`; the oldest past MAX_VERSIONS are
 * dropped. Files under build/dependency folders and large files keep none.
 */
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ArtifactInfo } from "@spriessen/contracts";
import { resolveInside } from "@spriessen/core";
import { blobPath, readSidecar, sidecarPath, writeSidecar } from "./durable-store.ts";
import { inSkippedDir } from "./skip-dirs.ts";

export const MAX_VERSIONS = 10;
export const MAX_VERSION_BYTES = 2_000_000;

const listOf = (dir: string, id: string): string => resolveInside(dir, `${id}.versions.json`);

/** The head's version ids, newest first. */
export const versionIds = (dir: string, id: string): readonly string[] => {
  const file = listOf(dir, id);
  if (!existsSync(file)) return [];
  try {
    const ids = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return Array.isArray(ids) ? ids.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
};

const dropOne = (dir: string, id: string): void => {
  rmSync(blobPath(dir, id), { force: true });
  rmSync(sidecarPath(dir, id), { force: true });
};

const saveIds = (dir: string, id: string, ids: readonly string[]): void => {
  if (ids.length === 0) rmSync(listOf(dir, id), { force: true });
  else writeFileSync(listOf(dir, id), JSON.stringify(ids));
};

/** Record an existing artifact as the head's newest version; prunes past the cap unless told not to. */
export const addVersion = (dir: string, id: string, versionId: string, prune = true): void => {
  const info = readSidecar(dir, versionId);
  if (info === undefined) return;
  if (info.versionOf !== id) writeSidecar(dir, { ...info, versionOf: id });
  const ids = [versionId, ...versionIds(dir, id).filter((v) => v !== versionId)];
  if (!prune) return saveIds(dir, id, ids);
  for (const old of ids.slice(MAX_VERSIONS)) dropOne(dir, old);
  saveIds(dir, id, ids.slice(0, MAX_VERSIONS));
};

/** Before an overwrite: keep the file's current bytes when they differ from the next ones. */
export const keepVersion = (dir: string, id: string, next: Uint8Array, treePath: string): void => {
  if (inSkippedDir(treePath)) return;
  const info = readSidecar(dir, id);
  const blob = blobPath(dir, id);
  if (info === undefined || !existsSync(blob) || statSync(blob).size > MAX_VERSION_BYTES) return;
  const current = readFileSync(blob);
  if (current.equals(next)) return;
  const versionId = randomUUID();
  writeFileSync(blobPath(dir, versionId), current);
  const { versionOf: _drop, ...head } = info;
  writeSidecar(dir, {
    ...head,
    id: versionId,
    versionOf: id,
    updatedAt: info.updatedAt ?? info.createdAt,
  });
  addVersion(dir, id, versionId);
};

/** The head's earlier versions, newest first. */
export const versionsOf = (dir: string, id: string): readonly ArtifactInfo[] =>
  versionIds(dir, id).flatMap((versionId) => readSidecar(dir, versionId) ?? []);

/** A file is gone: so are its versions. */
export const dropVersions = (dir: string, id: string): void => {
  for (const versionId of versionIds(dir, id)) dropOne(dir, versionId);
  saveIds(dir, id, []);
};
