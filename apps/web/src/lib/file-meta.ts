/**
 * Pure helpers for shared files (artifacts): what a preview can safely show,
 * human labels, and the two ways a file id reaches a card — a bot's markdown
 * link to /api/artifacts/<id> and a legacy artifact_write output line.
 */

export interface FileRef {
  readonly id: string;
  readonly name: string;
  /** Unknown until /meta fills it in; the card fetches lazily. */
  readonly mime?: string;
  readonly bytes?: number;
}

export type PreviewKind = "image" | "text" | "pdf" | "audio" | "video" | "none" | "blocked";

export const TEXT_PREVIEW_CHARS = 100_000;
export const MEDIA_PREVIEW_BYTES = 25_000_000;

/** Same shape the artifact store's validId enforces (1-64 chars, path-safe). */
const ID_SHAPE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/** Served inline only behind `CSP: sandbox`; the previewer never renders them. */
const BLOCKED_MIMES = new Set(["text/html", "image/svg+xml", "application/xhtml+xml"]);

/** Extensions worth rendering as text even when the mime is generic/unknown. */
const CODE_EXTS = new Set([
  "bash",
  "c",
  "cc",
  "conf",
  "cpp",
  "cs",
  "css",
  "csv",
  "cjs",
  "diff",
  "go",
  "h",
  "hpp",
  "ini",
  "java",
  "js",
  "json",
  "jsonl",
  "jsx",
  "kt",
  "log",
  "m",
  "markdown",
  "md",
  "mjs",
  "patch",
  "php",
  "pl",
  "py",
  "rb",
  "rs",
  "sh",
  "sql",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

/** Extension → one of the shiki langs the app bundles; "" highlights as plain text. */
const LANGS: Record<string, string> = {
  bash: "bash",
  cjs: "javascript",
  css: "css",
  diff: "diff",
  htm: "html",
  html: "html",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  md: "markdown",
  markdown: "markdown",
  mjs: "javascript",
  patch: "diff",
  py: "python",
  sh: "bash",
  sql: "sql",
  ts: "typescript",
  tsx: "tsx",
  txt: "text",
  xml: "html",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

const extOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
};

export const langOf = (name: string): string => LANGS[extOf(name)] ?? "";

export const previewKindOf = (mime: string | undefined, name: string): PreviewKind => {
  if (mime !== undefined) {
    if (BLOCKED_MIMES.has(mime)) return "blocked";
    if (mime.startsWith("image/")) return "image";
    if (mime === "application/pdf") return "pdf";
    if (mime.startsWith("audio/")) return "audio";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("text/") || mime === "application/json") return "text";
  }
  return CODE_EXTS.has(extOf(name)) ? "text" : "none";
};

const KINDS: Record<string, string> = {
  "text/markdown": "Markdown",
  "text/plain": "Text",
  "text/html": "Web page",
  "text/csv": "Spreadsheet (CSV)",
  "application/json": "JSON",
  "application/pdf": "PDF",
};

export const kindLabel = (mime: string | undefined, name: string): string => {
  if (mime !== undefined) {
    const known = KINDS[mime];
    if (known !== undefined) return known;
    if (mime.startsWith("image/")) return "Image";
    if (mime.startsWith("audio/")) return "Audio";
    if (mime.startsWith("video/")) return "Video";
  }
  const ext = extOf(name);
  return ext === "" ? "File" : ext.toUpperCase();
};

export const formatBytes = (n: number): string =>
  n >= 1_048_576
    ? `${(n / 1_048_576).toFixed(1)} MB`
    : n >= 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${n} B`;

/**
 * A bot reply link to an artifact, any host: bots may paste the LAN/8787 URL
 * while the owner browses the tailnet origin — the card fetches meta from its
 * own origin anyway, and a foreign id simply 404s into "unavailable".
 */
export const artifactLinkOf = (href: string): FileRef | null => {
  const trimmed = href.trim();
  if (trimmed === "") return null;
  let pathname: string;
  try {
    pathname = new URL(trimmed, "http://x").pathname;
  } catch {
    return null;
  }
  const match = /^\/api\/artifacts\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})$/.exec(pathname);
  const id = match?.[1];
  if (id === undefined) return null;
  return { id, name: id };
};

const WRITTEN = /^artifact (\S+) \((.+?)\) in your workspace/m;

/** Legacy artifact_write steps carry the id only in the output text. */
export const parseWrittenArtifact = (output: string): FileRef | null => {
  const match = WRITTEN.exec(output);
  const id = match?.[1];
  if (id === undefined || !ID_SHAPE.test(id)) return null;
  const name = match?.[2];
  return { id, name: name === undefined || name === "" ? id : name };
};
