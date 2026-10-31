/**
 * Path confinement: every file route and tool that turns a caller-supplied
 * name (an owner label, a profile id, an artifact id, a skill path) into a
 * file path goes through here. A path is accepted only when it stays inside
 * its root both lexically (after resolving `..`, absolute parts and
 * separators) and physically (realpath of the root against realpath of the
 * deepest existing part of the target, so a symlink pointing out is refused
 * even when its name looks harmless).
 */
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Thrown when a path would leave its root. The message never echoes file contents. */
export class PathEscapeError extends Error {
  readonly code = "EPATHESCAPE";
  readonly attempted: string;
  // Plain field + assignment, not a parameter property: the server runs this
  // file under Node's type stripping, which only accepts erasable syntax.
  constructor(attempted: string) {
    super(`refused: path "${attempted.slice(0, 120)}" is outside the allowed folder`);
    this.attempted = attempted;
    this.name = "PathEscapeError";
  }
}

export const isPathEscape = (cause: unknown): cause is PathEscapeError =>
  cause instanceof PathEscapeError ||
  (typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === "EPATHESCAPE");

/** One file or folder name: no separators, no NUL, not `.` or `..`, not empty. */
export const isSafeSegment = (segment: string): boolean =>
  segment.length > 0 &&
  segment.length <= 255 &&
  segment !== "." &&
  segment !== ".." &&
  !/[/\\\0]/.test(segment);

/** True when `target` is `root` or below it (both already absolute and normalised). */
export const isWithin = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

const exists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Resolve `parts` under `root` and return the absolute path, or throw
 * PathEscapeError when the result (or any symlink on the way to it) lands
 * outside `root`. Targets that do not exist yet are fine as long as their
 * deepest existing ancestor is inside.
 */
export const resolveInside = (root: string, ...parts: readonly string[]): string => {
  const base = resolve(root);
  const target = resolve(base, ...parts);
  const shown = parts.join("/");
  if (parts.some((part) => part.includes("\0")) || !isWithin(base, target)) {
    throw new PathEscapeError(shown);
  }
  // Nothing inside a missing root can be a symlink yet.
  if (!exists(base)) return target;
  const realBase = realpathSync(base);
  let probe = target;
  while (!exists(probe)) probe = dirname(probe);
  let realProbe: string;
  try {
    realProbe = realpathSync(probe);
  } catch {
    // A dangling symlink: wherever it points, it is not a file inside root.
    throw new PathEscapeError(shown);
  }
  if (!isWithin(realBase, realProbe)) throw new PathEscapeError(shown);
  return target;
};

/** resolveInside that answers undefined instead of throwing (for "not found" style reads). */
export const tryResolveInside = (root: string, ...parts: readonly string[]): string | undefined => {
  try {
    return resolveInside(root, ...parts);
  } catch (cause) {
    if (isPathEscape(cause)) return undefined;
    throw cause;
  }
};
