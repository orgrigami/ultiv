/**
 * Code parsing for the code-intel tools: web-tree-sitter (WASM, no native
 * deps) over the bot's own files. The runtime and grammar WASMs load lazily
 * inside the loader — importing @spriessen/ext must never load them (same
 * rule as the microsandbox SDK import), so nothing here may sit at top level.
 *
 * Unsupported languages are a normal answer, not an error: languageOf
 * returns undefined and callers skip symbol extraction for that file.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { Node, Tree } from "web-tree-sitter";

/** Files over this size are too big to parse. */
export const MAX_PARSE_CHARS = 300_000;

type Wts = typeof import("web-tree-sitter");

const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  py: "python",
};

/** The tree-sitter grammar name for a path, or undefined when unsupported. */
export const languageOf = (path: string): string | undefined => {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return EXTENSION_LANGUAGE[base.slice(dot + 1).toLowerCase()];
};

let runtime: Promise<Wts> | undefined;

const loadRuntime = (): Promise<Wts> => {
  runtime ??= (async () => {
    const wts = await import("web-tree-sitter");
    const require = createRequire(import.meta.url);
    const engine = require.resolve("web-tree-sitter/web-tree-sitter.wasm");
    await wts.Parser.init({ locateFile: () => engine });
    return wts;
  })();
  return runtime;
};

const grammars = new Map<string, Promise<import("web-tree-sitter").Language>>();

const loadLanguage = (name: string): Promise<import("web-tree-sitter").Language> => {
  let pending = grammars.get(name);
  if (pending === undefined) {
    pending = (async () => {
      const wts = await loadRuntime();
      const require = createRequire(import.meta.url);
      const bytes = await readFile(
        require.resolve(`@vscode/tree-sitter-wasm/wasm/tree-sitter-${name}.wasm`),
      );
      return wts.Language.load(new Uint8Array(bytes));
    })();
    grammars.set(name, pending);
  }
  return pending;
};

const parsers = new Map<string, Promise<import("web-tree-sitter").Parser>>();

const parserFor = (name: string): Promise<import("web-tree-sitter").Parser> => {
  let pending = parsers.get(name);
  if (pending === undefined) {
    pending = (async () => {
      const [wts, language] = await Promise.all([loadRuntime(), loadLanguage(name)]);
      return new wts.Parser().setLanguage(language);
    })();
    parsers.set(name, pending);
  }
  return pending;
};

/** Parse the text of a supported code file, or null (unsupported / too big / parse failed). */
export const parseCode = async (path: string, text: string): Promise<Tree | null> => {
  if (text.length > MAX_PARSE_CHARS) return null;
  const name = languageOf(path);
  if (name === undefined) return null;
  const parser = await parserFor(name);
  return parser.parse(text);
};

export interface SyntaxProblems {
  readonly count: number;
  readonly firstLine: number;
}

/** Count ERROR / missing nodes in a parsed tree, with the first one's line (1-based). */
export const syntaxProblems = (tree: Tree): SyntaxProblems | undefined => {
  let count = 0;
  let firstLine = 0;
  const visit = (node: Node): void => {
    if (node.type === "ERROR" || node.isMissing) {
      count += 1;
      if (firstLine === 0) firstLine = node.startPosition.row + 1;
    }
    for (let i = 0; i < node.childCount; i += 1) {
      const child = node.child(i);
      if (child !== null) visit(child);
    }
  };
  visit(tree.rootNode);
  return count === 0 ? undefined : { count, firstLine };
};
