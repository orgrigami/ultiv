/**
 * The artifact-store side of the durable tree: the blob + sidecar pair each
 * tree file is persisted as, and the reserved index pair. Every file in a
 * bot's tree is an artifact whose sidecar records its path; a file written
 * again at its path keeps its id and createdAt and moves updatedAt.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { posix } from "node:path";
import type { ArtifactInfo } from "@spriessen/contracts";
import { resolveInside } from "@spriessen/core";
import { mimeOfName, VFS_INDEX_ID } from "../plugins/artifacts.ts";
import type { VfsIndex } from "./durable-fs-shapes.ts";

/** Who a write is stamped with; null keeps what the sidecar already says. */
export interface StoreScope {
  readonly conversationId: string | null;
  readonly owner: string | null;
  readonly profile: string | null;
}

export const sidecarPath = (dir: string, id: string): string => resolveInside(dir, `${id}.json`);
export const blobPath = (dir: string, id: string): string => resolveInside(dir, `${id}.bin`);

/** One sidecar, or undefined when it is missing, unreadable or not this id's. */
export const readSidecar = (dir: string, id: string): ArtifactInfo | undefined => {
  const file = sidecarPath(dir, id);
  if (!existsSync(file)) return undefined;
  try {
    const info = JSON.parse(readFileSync(file, "utf8")) as Partial<ArtifactInfo>;
    return info.id === id && typeof info.name === "string" ? (info as ArtifactInfo) : undefined;
  } catch {
    return undefined;
  }
};

export const writeSidecar = (dir: string, info: ArtifactInfo): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(sidecarPath(dir, info.id), JSON.stringify(info));
};

/** "/reports/board.md" → "reports/board.md": the path a sidecar records. */
export const relativeOf = (treePath: string): string => treePath.replace(/^\/+/, "");

/** A sidecar's name and type follow its path; a kept name keeps its (possibly uploaded) type. */
const named = (existing: ArtifactInfo | undefined, treePath: string) => {
  const name = posix.basename(treePath);
  const mime = existing !== undefined && existing.name === name ? existing.mime : mimeOfName(name);
  return { name, mime, path: relativeOf(treePath) };
};

/** Write one tree file's bytes and stamp its sidecar (id, createdAt kept per path). */
export const writeFileBlob = (
  dir: string,
  id: string,
  bytes: Uint8Array,
  treePath: string,
  scope: StoreScope,
): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(blobPath(dir, id), bytes);
  const existing = readSidecar(dir, id);
  const now = Date.now();
  writeSidecar(dir, {
    id,
    ...named(existing, treePath),
    bytes: bytes.byteLength,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    conversationId: scope.conversationId ?? existing?.conversationId ?? null,
    owner: scope.owner ?? existing?.owner ?? null,
    profile: scope.profile ?? existing?.profile ?? null,
  });
};

/** A file moved or linked to a new path: its sidecar names the new place. */
export const restamp = (dir: string, id: string, treePath: string): void => {
  const existing = readSidecar(dir, id);
  if (existing === undefined) return;
  writeSidecar(dir, { ...existing, ...named(existing, treePath) });
};

/** Persist the index pair; blobs are always written before the map that references them. */
export const writeIndexPair = (dir: string, index: VfsIndex, scope: StoreScope): void => {
  mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(index);
  writeFileSync(blobPath(dir, VFS_INDEX_ID), body, "utf8");
  const createdAt = existsSync(sidecarPath(dir, VFS_INDEX_ID))
    ? (JSON.parse(readFileSync(sidecarPath(dir, VFS_INDEX_ID), "utf8")) as ArtifactInfo).createdAt
    : Date.now();
  writeSidecar(dir, {
    id: VFS_INDEX_ID,
    name: "workspace index",
    mime: "application/json",
    bytes: Buffer.byteLength(body, "utf8"),
    createdAt,
    ...scope,
  });
};
