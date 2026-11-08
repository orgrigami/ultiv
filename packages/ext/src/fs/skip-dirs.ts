/** Folders that are never worth walking for user-facing code or file listings. */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "__pycache__",
  ".venv",
  "venv",
  ".coverage",
  ".worktrees",
  ".next",
]);

/** A tree path inside one of SKIP_DIRS ("/app/node_modules/x/index.js"). */
export const inSkippedDir = (path: string): boolean =>
  path.split("/").some((part) => SKIP_DIRS.has(part));
