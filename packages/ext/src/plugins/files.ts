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
import { Type } from "typebox";
import { isPathEscape, resolveInside } from "@spreissen/core";
import { definePlugin, toolCapability, type Plugin } from "../plugin.ts";
import { defineTool, type Tool } from "../tool.ts";
import { DurableFs } from "../fs/durable-fs.ts";
import { bumpWorkspace } from "../fs/workspace-epoch.ts";
import { artifactsDir } from "./artifacts.ts";
import type { ScopeHolder } from "./vault.ts";

const MAX_PATH_CHARS = 512;
const MAX_READ_CHARS = 100_000;
const MAX_WRITE_CHARS = 1_000_000;
const MAX_HITS = 50;

export interface FilesOptions {
  /** Workspace root; default ARTIFACTS_DIR. */
  readonly root?: string;
  /** Required: without a scope there is no bot area, and every call is refused. */
  readonly holder: ScopeHolder;
}

type ToolResult = Awaited<ReturnType<Tool["execute"]>>;

const fail = (text: string): ToolResult => ({
  output: [{ type: "text" as const, text }],
  isError: true as const,
});

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

interface Area {
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
const safeAreaOf = (root: string, holder: ScopeHolder, conversationId: string): Area | string => {
  try {
    return areaOf(root, holder, conversationId);
  } catch (cause) {
    if (isPathEscape(cause)) return "this bot's folder points outside its workspace";
    throw cause;
  }
};

/** Refuse a path whose target or any folder on the way is a symlink. */
const throughSymlink = async (fs: DurableFs, path: string): Promise<boolean> => {
  const parts = path.split("/").filter((part) => part !== "");
  for (let i = 1; i <= parts.length; i += 1) {
    const prefix = `/${parts.slice(0, i).join("/")}`;
    if (!(await fs.exists(prefix))) return false;
    if ((await fs.lstat(prefix)).isSymbolicLink) return true;
  }
  return false;
};

/** Resolve the area and the path, refusing anything outside it. */
const locate = async (
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
const asText = (bytes: Uint8Array): string | undefined => {
  if (bytes.includes(0)) return undefined;
  const text = Buffer.from(bytes).toString("utf8");
  return text.includes("\uFFFD") ? undefined : text;
};

const show = (path: string): string => path.slice(1);

const readTool = (root: string, holder: ScopeHolder): Tool =>
  defineTool({
    name: "file_read",
    description:
      'Read one of your own files by its path, e.g. "notes/plan.md" (what bash shows under ' +
      "/home). Returns numbered lines; use start_line and line_count for big files. PDF or " +
      "Word files: use extract_document_text.",
    parameters: Type.Object({
      path: Type.String({ description: 'A path inside your files, e.g. "notes/plan.md".' }),
      start_line: Type.Optional(Type.Integer({ minimum: 1, description: "First line (1-based)." })),
      line_count: Type.Optional(Type.Integer({ minimum: 1, description: "How many lines." })),
    }),
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
    parameters: Type.Object({
      query: Type.String({ description: "Text to find in file names and contents." }),
      folder: Type.Optional(Type.String({ description: 'Only under this folder, e.g. "notes".' })),
    }),
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

const editTool = (root: string, holder: ScopeHolder): Tool =>
  defineTool({
    name: "file_edit",
    gated: true,
    description:
      "Change one of your own files. With old_text, replaces that exact text (it must appear " +
      "exactly once); without it, writes new_text as the whole file (creating it and its " +
      "folders). Your owner's approval mode applies: say in a sentence what you'll change first.",
    parameters: Type.Object({
      path: Type.String({ description: 'A path inside your files, e.g. "notes/plan.md".' }),
      new_text: Type.String({
        description: "The replacement, or the whole file without old_text.",
      }),
      old_text: Type.Optional(Type.String({ description: "Exact text to replace, once." })),
    }),
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
      return {
        output: [
          {
            type: "text" as const,
            text: `${exists ? "changed" : "created"} ${show(found.path)}`,
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
    parameters: Type.Object({
      path: Type.String({ description: 'A path inside your files, e.g. "notes/old.md".' }),
    }),
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
      toolCapability(editTool(root, holder)),
      toolCapability(deleteTool(root, holder)),
    ],
  });
};
