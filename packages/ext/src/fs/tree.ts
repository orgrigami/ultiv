/**
 * A bot's files as ONE tree. Every writer that is not bash itself — the
 * artifact tools, uploads, browser screenshots, artifacts granted by
 * another bot — puts its file at a path here, so every file is in the tree
 * bash sees under /home, file_read reads and the app lists. Writing a taken
 * path replaces that file in place (same id; the old bytes become a version,
 * see versions.ts) unless the writer asks for a free name instead. Each
 * change bumps the workspace epoch so an open VM reloads before its next run.
 */
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import type { ArtifactInfo } from "@spriessen/contracts";
import { copyArtifact, deleteArtifact } from "../plugins/artifacts.ts";
import { DurableFs } from "./durable-fs.ts";
import { blobPath, readSidecar, writeSidecar, type StoreScope } from "./durable-store.ts";
import { treePath } from "./tree-path.ts";
import { dropVersions } from "./versions.ts";
import { bumpWorkspace } from "./workspace-epoch.ts";

export interface PutOptions extends Partial<StoreScope> {
  /** A taken path gets a free name ("photo (2).png") instead of being replaced. */
  readonly unique?: boolean;
  /** The type to record when the name alone does not say it (an upload's). */
  readonly mime?: string;
}

export type PutResult =
  | { readonly info: ArtifactInfo; readonly replaced: boolean }
  | { readonly refused: string };

const treeOf = (dir: string, scope: Partial<StoreScope> = {}): DurableFs =>
  new DurableFs({
    dir,
    conversationId: scope.conversationId ?? null,
    owner: scope.owner ?? null,
    profile: scope.profile ?? null,
  });

/** "a/b.md" → "a/b (2).md"; a dotfile or a name without a dot gets the suffix at the end. */
const variant = (path: string, n: number): string => {
  const base = posix.basename(path);
  const dot = base.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
  return posix.join(posix.dirname(path), `${stem} (${n})${ext}`);
};

/** The path itself when it is free, else the first free numbered variant. */
export const freePath = async (fs: DurableFs, path: string): Promise<string> => {
  if (!(await fs.exists(path))) return path;
  for (let n = 2; ; n += 1) {
    const next = variant(path, n);
    if (!(await fs.exists(next))) return next;
  }
};

/** The folder on the way that is not a folder (a file or a link), if any. */
const blockedBy = async (fs: DurableFs, path: string): Promise<string | undefined> => {
  const parts = path.split("/").filter((part) => part !== "");
  for (let i = 1; i < parts.length; i += 1) {
    const prefix = `/${parts.slice(0, i).join("/")}`;
    if ((await fs.exists(prefix)) && !(await fs.lstat(prefix)).isDirectory) return prefix;
  }
  return undefined;
};

/** A name from outside (an upload, a legacy file) as a path in one folder, never a refusal. */
export const pathForName = (folder: string, name: string, fallback: string): string => {
  const flat = name.replace(/[/\\\0]/g, "-").trim();
  const parsed = treePath(folder === "" ? flat : `${folder}/${flat}`);
  return "path" in parsed ? parsed.path : `/${folder === "" ? fallback : `${folder}/${fallback}`}`;
};

/** Write one file at a tree path ("/reports/board.md"). */
export const putFile = async (
  dir: string,
  path: string,
  bytes: Uint8Array,
  options: PutOptions = {},
): Promise<PutResult> => {
  const fs = treeOf(dir, options);
  const target = options.unique === true ? await freePath(fs, path) : path;
  const blocked = await blockedBy(fs, target);
  if (blocked !== undefined) return { refused: `${blocked.slice(1)} is a file, not a folder` };
  if ((await fs.exists(target)) && !(await fs.lstat(target)).isFile)
    return { refused: `${target.slice(1)} is a folder or a link, not a file` };
  const replaced = fs.idOf(target) !== undefined;
  const parent = posix.dirname(target);
  if (parent !== "/") await fs.mkdir(parent, { recursive: true });
  await fs.writeFile(target, bytes);
  const id = fs.idOf(target);
  const stored = id === undefined ? undefined : readSidecar(dir, id);
  if (stored === undefined) return { refused: "the file could not be saved" };
  const info = options.mime !== undefined ? { ...stored, mime: options.mime } : stored;
  if (info !== stored) writeSidecar(dir, info);
  bumpWorkspace(dir);
  return { info, replaced };
};

/** Delete a file by id: every path it sits at, its versions, its bytes. False when unknown. */
export const removeFile = async (dir: string, id: string): Promise<boolean> => {
  const fs = treeOf(dir);
  const paths = fs.pathsOf(id);
  if (paths.length === 0) {
    const removed = deleteArtifact(dir, id);
    if (removed) dropVersions(dir, id);
    return removed;
  }
  for (const path of paths) await fs.rm(path, { force: true });
  bumpWorkspace(dir);
  return true;
};

/** Put an earlier version's bytes back at the file's path; the current bytes become a version. */
export const restoreVersion = async (
  dir: string,
  id: string,
  versionId: string,
  scope: Partial<StoreScope> = {},
): Promise<ArtifactInfo | undefined> => {
  const version = readSidecar(dir, versionId);
  if (version?.versionOf !== id) return undefined;
  const fs = treeOf(dir, scope);
  const path = fs.pathsOf(id)[0];
  if (path === undefined) return undefined;
  await fs.writeFile(path, readFileSync(blobPath(dir, versionId)));
  bumpWorkspace(dir);
  return readSidecar(dir, id);
};

/** Another bot's file granted to this one: the same id, placed under received/. */
export const grantInto = async (fromDir: string, toDir: string, id: string): Promise<boolean> => {
  const fs = treeOf(toDir);
  if (fs.pathsOf(id).length > 0) return true;
  if (!copyArtifact(fromDir, toDir, id)) return false;
  const info = readSidecar(toDir, id);
  if (info === undefined) return false;
  if (info.versionOf !== undefined) {
    const { versionOf: _version, ...head } = info;
    writeSidecar(toDir, head);
  }
  fs.place(await freePath(fs, pathForName("received", info.name, id)), id);
  bumpWorkspace(toDir);
  return true;
};
