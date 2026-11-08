/**
 * The bot's own files by path: file_read, file_search (open) and file_edit,
 * file_delete (gated, so Manual/Jev/YOLO apply). They work on the same
 * durable tree bash sees under /home, scoped to {ARTIFACTS_DIR}/{owner}/{bot}.
 *
 * Paths are workspace-relative ("notes/plan.md"). Refused, every tool:
 * absolute paths, `..` or `.` parts, empty parts, backslashes, NUL, any
 * symlink on the way, and a chat that maps to no bot (there is no "own
 * area" to confine to, so nothing is read or written).
 */
import { int, obj, opt, str } from "@earendil-works/pi-schema";
import { isPathEscape, resolveInside } from "@spriessen/core";
import { definePlugin, toolCapability, type Plugin } from "../plugin.ts";
import { defineTool, type Tool } from "../tool.ts";
import { DurableFs } from "../fs/durable-fs.ts";
import { bumpWorkspace } from "../fs/workspace-epoch.ts";
import { extractDocumentText } from "../docs/extract.ts";
import { MAX_PARSE_CHARS, languageOf, parseCode, syntaxProblems } from "../codeintel/parser.ts";
import { inSkippedDir } from "../fs/skip-dirs.ts";
import { treePath } from "../fs/tree-path.ts";
import { artifactsDir, readArtifactBytes } from "./artifacts.ts";
import type { ScopeHolder } from "./vault.ts";

const MAX_READ_CHARS = 100_000;
const MAX_WRITE_CHARS = 1_000_000;
const MAX_HITS = 50;
const MAX_FIND_PATHS = 100;

/**
 * A minimal glob: `*` within one path segment, `**` across segments,
 * `?` one character, everything else literal. No dependency.
 */
export const globToRegExp = (pattern: string): RegExp => {
  let source = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i] ?? "";
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        source += "(?:.*/)?";
        i += 2;
        if (pattern[i] === "/") i += 1;
      } else {
        source += "[^/]*";
        i += 1;
      }
    } else if (char === "?") {
      source += "[^/]";
      i += 1;
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${source}$`);
};

export interface FilesOptions {
  /** Workspace root; default ARTIFACTS_DIR. */
  readonly root?: string;
  /** Required: without a scope there is no bot area, and every call is refused. */
  readonly holder: ScopeHolder;
}

type ToolResult = Awaited<ReturnType<Tool["execute"]>>;

export const fail = (text: string): ToolResult => ({
  output: [{ type: "text" as const, text }],
  isError: true as const,
});

export { treePath } from "../fs/tree-path.ts";

export interface Area {
  readonly fs: DurableFs;
  readonly dir: string;
}

/** The bot's own tree for this chat, or why there is none. */
const areaOf = (root: string, holder: ScopeHolder, conversationId: string): Area | string => {
  const scope = holder.get()?.scopeOf(conversationId);
  if (scope === undefined) return "this chat belongs to no bot, so it has no files";
  const dir = resolveInside(root, scope.owner, scope.profile);
  return { fs: new DurableFs({ dir, conversationId, ...scope }), dir };
};

/** areaOf, with a bot folder that links out of the workspace refused rather than thrown. */
export const safeAreaOf = (
  root: string,
  holder: ScopeHolder,
  conversationId: string,
): Area | string => {
  try {
    return areaOf(root, holder, conversationId);
  } catch (cause) {
    if (isPathEscape(cause)) return "this bot's folder points outside its workspace";
    throw cause;
  }
};

/** Refuse a path whose target or any folder on the way is a symlink. */
export const throughSymlink = async (fs: DurableFs, path: string): Promise<boolean> => {
  const parts = path.split("/").filter((part) => part !== "");
  for (let i = 1; i <= parts.length; i += 1) {
    const prefix = `/${parts.slice(0, i).join("/")}`;
    if (!(await fs.exists(prefix))) return false;
    if ((await fs.lstat(prefix)).isSymbolicLink) return true;
  }
  return false;
};

/** Resolve the area and the path, refusing anything outside it. */
export const locate = async (
  root: string,
  holder: ScopeHolder,
  conversationId: string,
  raw: string,
): Promise<{ area: Area; path: string } | ToolResult> => {
  const area = safeAreaOf(root, holder, conversationId);
  if (typeof area === "string") return fail(`refused: ${area}`);
  const parsed = treePath(raw);
  if ("refused" in parsed) return fail(`refused: ${parsed.refused}`);
  if (await throughSymlink(area.fs, parsed.path))
    return fail("refused: the path goes through a link; use the file's own path");
  return { area, path: parsed.path };
};

const isResult = (value: unknown): value is ToolResult =>
  typeof value === "object" && value !== null && "output" in value;

/** UTF-8 text, or undefined for binary content. */
export const asText = (bytes: Uint8Array): string | undefined => {
  if (bytes.includes(0)) return undefined;
  const text = Buffer.from(bytes).toString("utf8");
  return text.includes("\uFFFD") ? undefined : text;
};

const show = (path: string): string => path.slice(1);

/**
 * After a successful write of a supported code file: a syntax-error note, or
 * nothing at all (a clean parse and an unsupported language stay silent, so
 * exact result strings are unchanged).
 */
const syntaxNoteOf = async (path: string, text: string): Promise<string> => {
  if (languageOf(path) === undefined || text.length > MAX_PARSE_CHARS) return "";
  const tree = await parseCode(path, text);
  const problems = tree === null ? undefined : syntaxProblems(tree);
  if (problems === undefined) return "";
  return `\nnote: ${problems.count} syntax error(s) detected, first at line ${problems.firstLine}`;
};

const readTool = (root: string, holder: ScopeHolder): Tool =>
  defineTool({
    name: "file_read",
    description:
      'Read one of your own files by its path, e.g. "notes/plan.md" (what bash shows under ' +
      "/home). Returns numbered lines; use start_line and line_count for big files. PDF or " +
      "Word files: use extract_document_text.",
    parameters: obj(
      {
        path: str({ description: 'A path inside your files, e.g. "notes/plan.md".' }),
        start_line: opt(int({ minimum: 1, description: "First line (1-based)." })),
        line_count: opt(int({ minimum: 1, description: "How many lines." })),
      },
      { open: true },
    ),
    execute: async (args, api) => {
      const found = await locate(root, holder, String(api.conversationId), args.path);
      if (isResult(found)) return found;
      const { fs } = found.area;
      if (!(await fs.exists(found.path))) return fail(`no file at ${show(found.path)}`);
      if (!(await fs.stat(found.path)).isFile) return fail(`${show(found.path)} is a folder`);
      const text = asText(await fs.readFileBuffer(found.path));
      if (text === undefined)
        return fail(
          `${show(found.path)} isn't text; for a PDF or Word file use extract_document_text`,
        );
      const lines = text.split("\n");
      const start = (args.start_line ?? 1) - 1;
      const slice = lines.slice(
        start,
        args.line_count === undefined ? undefined : start + args.line_count,
      );
      let body = slice.map((line, i) => `${start + i + 1}\t${line}`).join("\n");
      if (body.length > MAX_READ_CHARS)
        body = `${body.slice(0, MAX_READ_CHARS)}\n[cut at ${MAX_READ_CHARS} characters; read on with start_line]`;
      return {
        output: [
          { type: "text" as const, text: `# ${show(found.path)} (${lines.length} lines)\n${body}` },
        ],
      };
    },
  });

const searchTool = (root: string, holder: ScopeHolder): Tool =>
  defineTool({
    name: "file_search",
    description:
      "Search your own files: names and text lines containing the query (case-insensitive), " +
      "optionally only under one folder. Returns paths and matching line numbers.",
    parameters: obj(
      {
        query: str({ description: "Text to find in file names and contents." }),
        folder: opt(str({ description: 'Only under this folder, e.g. "notes".' })),
      },
      { open: true },
    ),
    execute: async (args, api) => {
      const area = safeAreaOf(root, holder, String(api.conversationId));
      if (typeof area === "string") return fail(`refused: ${area}`);
      let prefix = "/";
      if (args.folder !== undefined && args.folder.trim() !== "") {
        const found = await locate(root, holder, String(api.conversationId), args.folder);
        if (isResult(found)) return found;
        prefix = `${found.path}/`;
      }
      const query = args.query.trim().toLowerCase();
      if (query === "") return fail("a query is required");
      const hits: { path: string; lines: number[] }[] = [];
      for (const path of area.fs.allFilePaths()) {
        if (hits.length >= MAX_HITS) break;
        if (!path.startsWith(prefix) || (await throughSymlink(area.fs, path))) continue;
        const text = asText(await area.fs.readFileBuffer(path));
        const lines =
          text === undefined
            ? []
            : text
                .split("\n")
                .flatMap((line, i) => (line.toLowerCase().includes(query) ? [i + 1] : []))
                .slice(0, 20);
        if (lines.length > 0 || path.toLowerCase().includes(query))
          hits.push({ path: show(path), lines });
      }
      const text =
        hits.length === 0
          ? "no matches"
          : hits
              .map((hit) =>
                hit.lines.length === 0 ? hit.path : `${hit.path}: lines ${hit.lines.join(", ")}`,
              )
              .join("\n");
      return { output: [{ type: "text" as const, text }], structuredOutput: hits };
    },
  });

const findTool = (root: string, holder: ScopeHolder): Tool =>
  defineTool({
    name: "file_find",
    description:
      'Find your own files by name pattern (a glob): "*.py", "report*", or with folders in it ' +
      '"src/**/*.md". Optionally search only under one folder. Nothing in skipped folders ' +
      "(node_modules, .git, dist, build, caches) is listed.",
    parameters: obj(
      {
        pattern: str({
          description:
            'A glob: * within a name, ** across folders, ? one character, e.g. "*.py" or "src/**/*.md".',
        }),
        path: opt(str({ description: 'Only under this folder, e.g. "notes".' })),
      },
      { open: true },
    ),
    execute: async (args, api) => {
      const pattern = args.pattern.trim();
      if (pattern === "") return fail("a pattern is required");
      const area = safeAreaOf(root, holder, String(api.conversationId));
      if (typeof area === "string") return fail(`refused: ${area}`);
      let prefix = "/";
      if (args.path !== undefined && args.path.trim() !== "") {
        const found = await locate(root, holder, String(api.conversationId), args.path);
        if (isResult(found)) return found;
        prefix = `${found.path}/`;
      }
      const matcher = globToRegExp(pattern);
      const withFolders = pattern.includes("/");
      const matches: string[] = [];
      let total = 0;
      for (const path of area.fs.allFilePaths()) {
        if (!path.startsWith(prefix) || inSkippedDir(path)) continue;
        if (await throughSymlink(area.fs, path)) continue;
        const relative = show(path);
        const target = withFolders ? relative : relative.slice(relative.lastIndexOf("/") + 1);
        if (!matcher.test(target)) continue;
        total += 1;
        if (matches.length < MAX_FIND_PATHS) matches.push(relative);
      }
      const text =
        matches.length === 0
          ? "no matches"
          : `${matches.join("\n")}\n${total} match(es) for "${pattern}"` +
            (total > MAX_FIND_PATHS ? `, showing the first ${MAX_FIND_PATHS}` : "");
      return { output: [{ type: "text" as const, text }], structuredOutput: { matches } };
    },
  });

const editTool = (root: string, holder: ScopeHolder): Tool =>
  defineTool({
    name: "file_edit",
    gated: true,
    description:
      "Change one of your own files. With old_text, replaces that exact text (it must appear " +
      "exactly once); without it, writes new_text as the whole file (creating it and its " +
      "folders). Your owner's approval mode applies: say in a sentence what you'll change first.",
    parameters: obj(
      {
        path: str({ description: 'A path inside your files, e.g. "notes/plan.md".' }),
        new_text: str({
          description: "The replacement, or the whole file without old_text.",
        }),
        old_text: opt(str({ description: "Exact text to replace, once." })),
      },
      { open: true },
    ),
    execute: async (args, api) => {
      const found = await locate(root, holder, String(api.conversationId), args.path);
      if (isResult(found)) return found;
      const { fs, dir } = found.area;
      const exists = await fs.exists(found.path);
      if (exists && !(await fs.stat(found.path)).isFile)
        return fail(`${show(found.path)} is a folder`);
      let next = args.new_text;
      if (args.old_text !== undefined) {
        if (!exists) return fail(`no file at ${show(found.path)}`);
        const text = asText(await fs.readFileBuffer(found.path));
        if (text === undefined) return fail(`${show(found.path)} isn't text`);
        const count = args.old_text === "" ? 0 : text.split(args.old_text).length - 1;
        if (count !== 1)
          return fail(
            count === 0
              ? "old_text isn't in the file; read it again and copy the exact text"
              : `old_text appears ${count} times; add more of the surrounding text so it's unique`,
          );
        next = text.replace(args.old_text, () => args.new_text);
      }
      if (next.length > MAX_WRITE_CHARS)
        return fail(`the file would exceed ${MAX_WRITE_CHARS} characters`);
      const folder = found.path.slice(0, found.path.lastIndexOf("/"));
      if (folder !== "") await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(found.path, next);
      bumpWorkspace(dir);
      const note = await syntaxNoteOf(found.path, next);
      return {
        output: [
          {
            type: "text" as const,
            text: `${exists ? "changed" : "created"} ${show(found.path)}${note}`,
          },
        ],
        structuredOutput: { path: show(found.path), created: !exists },
      };
    },
  });

const deleteTool = (root: string, holder: ScopeHolder): Tool =>
  defineTool({
    name: "file_delete",
    gated: true,
    description:
      "Delete one of your own files by path (not folders). It can't be undone and your " +
      "owner's approval mode applies: name the file and say why first.",
    parameters: obj(
      {
        path: str({ description: 'A path inside your files, e.g. "notes/old.md".' }),
      },
      { open: true },
    ),
    execute: async (args, api) => {
      const found = await locate(root, holder, String(api.conversationId), args.path);
      if (isResult(found)) return found;
      const { fs, dir } = found.area;
      if (!(await fs.exists(found.path))) return fail(`no file at ${show(found.path)}`);
      if (!(await fs.stat(found.path)).isFile) return fail(`${show(found.path)} is a folder`);
      await fs.rm(found.path);
      bumpWorkspace(dir);
      return {
        output: [{ type: "text" as const, text: `deleted ${show(found.path)}` }],
        structuredOutput: { path: show(found.path), deleted: true },
      };
    },
  });

const extractTool = (root: string, holder: ScopeHolder): Tool =>
  defineTool({
    name: "extract_document_text",
    description:
      "Get the text of a PDF or Word (.docx) file: one of your files by path, or a file the " +
      "owner shared by its artifact id. Scanned pages have no text (there is no OCR). Long " +
      "documents come in parts: pass start_char to read on.",
    parameters: obj(
      {
        path: opt(str({ description: 'A path inside your files, e.g. "in/report.pdf".' })),
        artifact_id: opt(str({ description: "An artifact id from artifact_list." })),
        start_char: opt(int({ minimum: 0, description: "Where to read on from." })),
      },
      { open: true },
    ),
    execute: async (args, api) => {
      const conversationId = String(api.conversationId);
      if ((args.path === undefined) === (args.artifact_id === undefined))
        return fail("give exactly one of path or artifact_id");
      let bytes: Uint8Array;
      let name: string;
      if (args.path !== undefined) {
        const found = await locate(root, holder, conversationId, args.path);
        if (isResult(found)) return found;
        if (!(await found.area.fs.exists(found.path)))
          return fail(`no file at ${show(found.path)}`);
        if (!(await found.area.fs.stat(found.path)).isFile)
          return fail(`${show(found.path)} is a folder`);
        bytes = await found.area.fs.readFileBuffer(found.path);
        name = show(found.path);
      } else {
        const area = safeAreaOf(root, holder, conversationId);
        if (typeof area === "string") return fail(`refused: ${area}`);
        const artifact = readArtifactBytes(area.dir, args.artifact_id ?? "");
        if (artifact === undefined) return fail(`unknown artifact: ${args.artifact_id ?? ""}`);
        bytes = artifact.data;
        name = artifact.info.name;
      }
      const extracted = extractDocumentText(bytes);
      if (!extracted.ok) return fail(`${name}: ${extracted.reason}`);
      const start = Math.min(args.start_char ?? 0, extracted.text.length);
      const part = extracted.text.slice(start, start + MAX_READ_CHARS);
      const end = start + part.length;
      const more =
        end < extracted.text.length
          ? `\n[characters ${start}-${end} of ${extracted.text.length}; read on with start_char ${end}]`
          : "";
      return {
        output: [{ type: "text" as const, text: `# ${name} (${extracted.kind})\n${part}${more}` }],
        structuredOutput: { name, kind: extracted.kind, chars: extracted.text.length, start, end },
      };
    },
  });

/** The bot's own files by path; reads open, changes gated. */
export const filesPlugin = (options: FilesOptions): Plugin => {
  const root = options.root ?? artifactsDir();
  const { holder } = options;
  return definePlugin({
    id: "ultiv.files",
    version: "1.0.0",
    description:
      "The bot's own files by path: open read and search, gated edit and delete, confined to " +
      "the bot's area.",
    capabilities: [
      toolCapability(readTool(root, holder)),
      toolCapability(searchTool(root, holder)),
      toolCapability(findTool(root, holder)),
      toolCapability(editTool(root, holder)),
      toolCapability(deleteTool(root, holder)),
      toolCapability(extractTool(root, holder)),
    ],
  });
};
