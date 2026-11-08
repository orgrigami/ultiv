/**
 * Code-structure tools over the bot's own files: code_outline (an indented
 * tree with the symbols inside each code file) and code_nav (definitions and
 * references of a name). Both are read-only, so they are open — no gating,
 * no caller restriction. They share the file tools' scoping: paths are
 * workspace-relative, confined to the bot's area, symlinks refused, and a
 * chat with no bot gets nothing. Parsing rides the codeintel leaf modules,
 * which load their WASM runtime lazily.
 */
import { arr, bool, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { Tree } from "web-tree-sitter";
import { languageOf, parseCode } from "../codeintel/parser.ts";
import { findReferences, symbolsOf, type Symbol } from "../codeintel/symbols.ts";
import { definePlugin, toolCapability, type Plugin } from "../plugin.ts";
import { defineTool, type Tool } from "../tool.ts";
import { artifactsDir } from "./artifacts.ts";
import { asText, fail, locate, safeAreaOf, throughSymlink, type Area } from "./files.ts";
import type { ScopeHolder } from "./vault.ts";
import { inSkippedDir } from "../fs/skip-dirs.ts";

export { SKIP_DIRS } from "../fs/skip-dirs.ts";

const MAX_OUTLINE_CHARS = 6000;
const MAX_SYMBOLS_PER_FILE = 30;
const MAX_NAV_HITS = 50;
const MAX_EXCERPT_CHARS = 120;

const KIND_LABEL: Record<Symbol["kind"], string> = {
  function: "fn",
  method: "method",
  class: "class",
  const: "const",
  type: "type",
  interface: "interface",
};

export interface CodeIntelOptions {
  /** Workspace root; default ARTIFACTS_DIR. */
  readonly root?: string;
  /** Required: without a scope there is no bot area, and every call is refused. */
  readonly holder: ScopeHolder;
}

type ToolResult = Awaited<ReturnType<Tool["execute"]>>;

const isResult = (value: unknown): value is ToolResult =>
  typeof value === "object" && value !== null && "output" in value;

const show = (path: string): string => path.slice(1);

const skipped = inSkippedDir;

interface ParsedFile {
  readonly path: string;
  readonly language: string;
  readonly tree: Tree;
}

interface Scan {
  readonly files: number;
  readonly paths: readonly string[];
  readonly parsed: readonly ParsedFile[];
}

/** Every file under the prefix, with supported languages parsed. */
const scan = async (area: Area, prefix: string): Promise<Scan> => {
  const paths: string[] = [];
  const parsed: ParsedFile[] = [];
  for (const path of area.fs.allFilePaths()) {
    if (!path.startsWith(prefix) || skipped(path) || (await throughSymlink(area.fs, path)))
      continue;
    paths.push(path);
    const language = languageOf(path);
    if (language === undefined) continue;
    const text = asText(await area.fs.readFileBuffer(path));
    if (text === undefined) continue;
    const tree = await parseCode(path, text);
    if (tree === null) continue;
    parsed.push({ path, language, tree });
  }
  paths.sort();
  return { files: paths.length, paths, parsed };
};

const scopeLine = (scope: string, scanned: Scan): string =>
  `scope: ${scope} (${scanned.files} file(s), ${scanned.parsed.length} parsed)`;

// --- code_outline ------------------------------------------------------------

type OutlineSymbol = { name: string; kind: string; line: number };
type OutlineFile = { path: string; symbols: OutlineSymbol[] };

interface OutlineNode {
  readonly dirs: Map<string, OutlineNode>;
  readonly files: string[];
}

const buildTree = (paths: readonly string[], prefix: string): OutlineNode => {
  const rootNode: OutlineNode = { dirs: new Map(), files: [] };
  for (const path of paths) {
    const parts = path
      .slice(prefix.length)
      .split("/")
      .filter((part) => part !== "");
    let node = rootNode;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] ?? "";
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { dirs: new Map(), files: [] };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.push(path);
  }
  return rootNode;
};

const addLine = (lines: string[], budget: number, line: string): number =>
  lines.join("\n").length + line.length + 1 <= budget ? (lines.push(line), budget) : -1;

/** Renders into `lines` until the depth or the char budget runs out; false when cut short. */
const renderOutline = (
  node: OutlineNode,
  parsed: ReadonlyMap<string, ParsedFile>,
  prefix: string,
  depthLeft: number,
  indent: string,
  lines: string[],
  entries: OutlineFile[],
  budget: number,
): boolean => {
  const byName = ([a]: [string, unknown], [b]: [string, unknown]) => a.localeCompare(b);
  for (const [name, child] of [...node.dirs].sort(byName)) {
    if (addLine(lines, budget, `${indent}${name}/`) < 0) return false;
    if (depthLeft <= 1) continue;
    if (!renderOutline(child, parsed, prefix, depthLeft - 1, `${indent}  `, lines, entries, budget))
      return false;
  }
  for (const path of [...node.files].sort()) {
    if (addLine(lines, budget, `${indent}${path.slice(prefix.length)}`) < 0) return false;
    const file = parsed.get(path);
    if (file === undefined) continue;
    const symbols = symbolsOf(file.tree, file.language).slice(0, MAX_SYMBOLS_PER_FILE);
    let listed = true;
    for (const symbol of symbols) {
      const label = `${KIND_LABEL[symbol.kind]} ${symbol.name}:${symbol.line}`;
      if (addLine(lines, budget, `${indent}  ${label}`) < 0) {
        listed = false;
        break;
      }
    }
    if (!listed) return false;
    entries.push({
      path: show(path),
      symbols: symbols.map(({ name, kind, line }) => ({ name, kind, line })),
    });
  }
  return true;
};

const outlineOutput = obj(
  {
    scope: str(),
    files: int(),
    parsed: int(),
    truncated: bool(),
    entries: arr(
      obj(
        {
          path: str(),
          symbols: arr(obj({ name: str(), kind: str(), line: int() }, { open: true })),
        },
        { open: true },
      ),
    ),
  },
  { open: true },
);

const resolvePrefix = async (
  root: string,
  holder: ScopeHolder,
  conversationId: string,
  raw: string | undefined,
): Promise<{ prefix: string } | ToolResult> => {
  if (raw === undefined || raw.trim() === "") return { prefix: "/" };
  const found = await locate(root, holder, conversationId, raw);
  if (isResult(found)) return found;
  return { prefix: `${found.path}/` };
};

const outlineTool = (root: string, holder: ScopeHolder): Tool =>
  defineTool({
    name: "code_outline",
    description:
      "Outline your own files as an indented tree: folders, files, and the symbols (functions, " +
      "classes, methods, consts, types, interfaces) in each code file with their line numbers. " +
      "Call this ONCE at the start of working in a code workspace; paths are workspace-relative " +
      "like the file tools (bash shows the same tree as /home). TypeScript, TSX, JavaScript and " +
      "Python are parsed; other files appear without symbols.",
    parameters: obj(
      {
        path: opt(str({ description: 'Only under this folder, e.g. "src".' })),
        depth: opt(
          int({ minimum: 1, maximum: 6, description: "Folder levels to show (default 4)." }),
        ),
      },
      { open: true },
    ),
    structuredOutputSchema: outlineOutput,
    execute: async (args, api) => {
      const conversationId = String(api.conversationId);
      const area = safeAreaOf(root, holder, conversationId);
      if (typeof area === "string") return fail(`refused: ${area}`);
      const prefix = await resolvePrefix(root, holder, conversationId, args.path);
      if (isResult(prefix)) return prefix;
      const scanned = await scan(area, prefix.prefix);
      const scope = show(prefix.prefix).replace(/\/$/, "") || ".";
      const parsed = new Map(scanned.parsed.map((file) => [file.path, file]));
      const lines: string[] = [scopeLine(scope, scanned)];
      const entries: OutlineFile[] = [];
      const complete = renderOutline(
        buildTree(scanned.paths, prefix.prefix),
        parsed,
        prefix.prefix,
        args.depth ?? 4,
        "",
        lines,
        entries,
        MAX_OUTLINE_CHARS - 60,
      );
      let text = lines.join("\n");
      let truncated = false;
      if (!complete) {
        text = `${text}\n(truncated: narrow with path or depth)`;
        truncated = true;
      }
      return {
        output: [{ type: "text" as const, text }],
        structuredOutput: {
          scope,
          files: scanned.files,
          parsed: scanned.parsed.length,
          truncated,
          entries,
        },
      };
    },
  });

// --- code_nav ----------------------------------------------------------------

type NavHit = {
  path: string;
  line: number;
  kind?: string;
  name?: string;
  column?: number;
  excerpt: string;
};

const navOutput = obj(
  {
    scope: str(),
    action: str(),
    name: str(),
    files: int(),
    parsed: int(),
    hits: arr(
      obj(
        {
          path: str(),
          line: int(),
          kind: opt(str()),
          name: opt(str()),
          column: opt(int()),
          excerpt: str(),
        },
        { open: true },
      ),
    ),
  },
  { open: true },
);

const excerptOf = (file: ParsedFile, line: number): string => {
  const raw = file.tree.rootNode.text.split("\n")[line - 1] ?? "";
  const trimmed = raw.trim();
  return trimmed.length > MAX_EXCERPT_CHARS ? `${trimmed.slice(0, MAX_EXCERPT_CHARS)}…` : trimmed;
};

const definitionHits = (file: ParsedFile, name: string): NavHit[] =>
  symbolsOf(file.tree, file.language)
    .filter((symbol) => symbol.name === name)
    .map((symbol) => ({
      path: show(file.path),
      line: symbol.line,
      kind: symbol.kind,
      name: symbol.name,
      excerpt: excerptOf(file, symbol.line),
    }));

const referenceHits = (file: ParsedFile, name: string): NavHit[] =>
  findReferences(file.tree, file.language, name).map((reference) => ({
    path: show(file.path),
    line: reference.line,
    column: reference.column,
    excerpt: reference.excerpt,
  }));

const navTool = (root: string, holder: ScopeHolder): Tool =>
  defineTool({
    name: "code_nav",
    description:
      "Find where a name lives in your own code files. definitions: where it is declared " +
      "(functions, classes, methods, consts, types, interfaces). references: every occurrence " +
      'in code, excluding strings and comments. Optionally search only one folder, e.g. "src". ' +
      "Paths are workspace-relative like the file tools; TypeScript, TSX, JavaScript and Python " +
      "are parsed.",
    parameters: obj(
      {
        action: oneOf(["definitions", "references"], {
          description: "Look up declarations or code occurrences.",
        }),
        name: str({ description: 'The symbol name, e.g. "greet".' }),
        path: opt(str({ description: 'Only under this folder, e.g. "src".' })),
      },
      { open: true },
    ),
    structuredOutputSchema: navOutput,
    execute: async (args, api) => {
      const conversationId = String(api.conversationId);
      const area = safeAreaOf(root, holder, conversationId);
      if (typeof area === "string") return fail(`refused: ${area}`);
      const prefix = await resolvePrefix(root, holder, conversationId, args.path);
      if (isResult(prefix)) return prefix;
      const scanned = await scan(area, prefix.prefix);
      const scope = show(prefix.prefix).replace(/\/$/, "") || ".";
      const base = { scope, action: args.action, name: args.name };
      if (scanned.parsed.length === 0) {
        const text =
          `${scopeLine(scope, scanned)}\nno parseable code files here; only TypeScript, ` +
          "TSX, JavaScript and Python are parsed, so there is nothing to navigate";
        return {
          output: [{ type: "text" as const, text }],
          structuredOutput: { ...base, files: scanned.files, parsed: 0, hits: [] },
        };
      }
      const hits: NavHit[] = [];
      for (const file of scanned.parsed) {
        if (hits.length >= MAX_NAV_HITS) break;
        hits.push(
          ...(args.action === "definitions"
            ? definitionHits(file, args.name)
            : referenceHits(file, args.name)),
        );
      }
      const shown = hits.slice(0, MAX_NAV_HITS);
      const lines = shown.flatMap((hit) => [
        hit.kind !== undefined
          ? `${hit.path}:${hit.line}  ${KIND_LABEL[hit.kind as Symbol["kind"]]} ${hit.name}`
          : `${hit.path}:${hit.line}:${hit.column}`,
        `    ${hit.excerpt}`,
      ]);
      const over = hits.length > MAX_NAV_HITS ? `, showing the first ${MAX_NAV_HITS}` : "";
      const text =
        `${scopeLine(scope, scanned)}\n${lines.join("\n")}${lines.length > 0 ? "\n" : ""}` +
        `${hits.length} match(es) for "${args.name}" (${args.action})${over}`;
      return {
        output: [{ type: "text" as const, text }],
        structuredOutput: {
          ...base,
          files: scanned.files,
          parsed: scanned.parsed.length,
          hits: shown,
        },
      };
    },
  });

/** Code-structure tools over the bot's own files; both open, read-only. */
export const codeIntelPlugin = (options: CodeIntelOptions): Plugin => {
  const root = options.root ?? artifactsDir();
  const { holder } = options;
  return definePlugin({
    id: "ultiv.code-intel",
    version: "1.0.0",
    description:
      "Code structure over the bot's own files: an outline of folders, files and symbols, and " +
      "definitions/references navigation, parsed from the tree.",
    capabilities: [
      toolCapability(outlineTool(root, holder)),
      toolCapability(navTool(root, holder)),
    ],
  });
};
