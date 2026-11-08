/**
 * The one rule for a workspace-relative path in a bot's tree, shared by the
 * file tools and artifact_write: relative, no "..", "." or empty parts, no
 * backslash or NUL, capped. Bash sees the same tree under /home.
 */
const MAX_PATH_CHARS = 512;

/** A workspace-relative path as a tree path ("/notes/plan.md"), or why it is refused. */
export const treePath = (raw: string): { path: string } | { refused: string } => {
  const value = raw.trim();
  if (value === "") return { refused: "a path is required" };
  if (value.length > MAX_PATH_CHARS) return { refused: "the path is too long" };
  if (value.includes("\0") || value.includes("\\"))
    return { refused: "the path has a character files can't use" };
  if (value.startsWith("/") || value.startsWith("~") || /^[a-zA-Z]:/.test(value))
    return {
      refused:
        'only paths inside your own files work; use a relative path like "notes/plan.md" ' +
        "(bash shows it as /home/notes/plan.md)",
    };
  const parts = value.replace(/\/+$/, "").split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".."))
    return { refused: 'the path can\'t contain "..", "." or empty parts' };
  return { path: `/${parts.join("/")}` };
};
