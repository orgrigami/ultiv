/**
 * DurableFs's fs-shaped types, path helpers and POSIX-style errors (ENOENT,
 * EEXIST, EISDIR, ENOTDIR, ENOTEMPTY), kept local since just-bash was
 * replaced by microsandbox.
 */

import { posix } from "node:path";

/** Minimal fs-shape types, local since just-bash was replaced by microsandbox. */
export type BufferEncoding = "utf8" | "utf-8" | "latin1" | "binary";

export type FileContent = string | Uint8Array;

export interface FsStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly mode: number;
  readonly size: number;
  readonly mtime: Date;
}

export interface MkdirOptions {
  readonly recursive?: boolean;
}

export interface RmOptions {
  readonly force?: boolean;
  readonly recursive?: boolean;
}

export interface CpOptions {
  readonly recursive?: boolean;
}

export interface CreateExclusiveOptions {
  readonly directory?: boolean;
  readonly mode: number;
}

export interface VfsEntry {
  readonly kind: "file" | "dir" | "symlink";
  /** The artifact id backing a file (shared by hard links). */
  readonly id?: string;
  /** The target of a symlink. */
  readonly target?: string;
  mode: number;
  mtime: number;
}

export interface VfsIndex {
  readonly paths: Record<string, VfsEntry>;
}

export const normalize = (value: string): string => {
  const resolved = posix.resolve("/", value);
  return resolved === "/" ? "/" : resolved.replace(/\/+$/, "");
};

export const parentOf = (value: string): string => {
  const parent = posix.dirname(value);
  return parent === value ? "/" : parent;
};

export const enoent = (operation: string, value: string): Error =>
  Object.assign(new Error(`ENOENT: no such file or directory, ${operation} '${value}'`), {
    code: "ENOENT",
  });
export const eexists = (value: string): Error =>
  Object.assign(new Error(`EEXIST: file already exists, '${value}'`), { code: "EEXIST" });
export const eisdir = (value: string): Error =>
  Object.assign(new Error(`EISDIR: illegal operation on a directory, ${value}`), {
    code: "EISDIR",
  });
export const enotdir = (value: string): Error =>
  Object.assign(new Error(`ENOTDIR: not a directory, ${value}`), { code: "ENOTDIR" });
export const enotempty = (value: string): Error =>
  Object.assign(new Error(`ENOTEMPTY: directory not empty, ${value}`), { code: "ENOTEMPTY" });

export const DEFAULT_MODE_FILE = 0o666;

export const DEFAULT_MODE_DIR = 0o777;

/** Not exported by any dependency; defined here for callers' convenience. */
export interface ReadFileOptions {
  readonly encoding?: BufferEncoding | null;
}

export interface WriteFileOptions {
  readonly encoding?: BufferEncoding;
}

export interface DirentEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
}
