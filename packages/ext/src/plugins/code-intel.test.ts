import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableFs } from "../fs/durable-fs.ts";
import { codeIntelPlugin } from "./code-intel.ts";
import { createScopeHolder } from "./vault.ts";

const root = mkdtempSync(join(tmpdir(), "spriessen-code-intel-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const scopes: Record<string, { owner: string; profile: string }> = {
  "conv-a": { owner: "owner-a", profile: "bot-1" },
};
const holder = createScopeHolder();
holder.set({ scopeOf: (cid) => scopes[cid] });

const plugin = codeIntelPlugin({ root, holder });
const tool = (name: string) => {
  const capability = plugin.capabilities.find(
    (candidate) => candidate.kind === "tool" && candidate.tool.name === name,
  );
  if (capability?.kind !== "tool") throw new Error(`missing ${name}`);
  return capability.tool;
};
const call = async (name: string, args: Record<string, unknown>, cid = "conv-a") => {
  const result = await tool(name).execute(
    args as never,
    { conversationId: cid } as never,
    {} as never,
  );
  const text = (result.output ?? []).map((part) => ("text" in part ? part.text : "")).join("");
  return { text, isError: result.isError === true, structured: result.structuredOutput };
};

const tree = new DurableFs({ dir: join(root, "owner-a", "bot-1") });

const APP_TS = [
  "export function greet(name: string): string {",
  "  return `hello ${name}`;",
  "}",
  "",
  "export class Greeter {",
  "  greet(name: string): string { return greet(name); }",
  "}",
  "",
  "export const add = (a: number, b: number): number => a + b;",
  "",
  "export type Label = string;",
  "",
  "export interface Named { name: string }",
].join("\n");

const TOOL_PY = [
  "def clamp(value, low, high):",
  '    """clamp a value into range"""',
  "    return max(low, min(high, value))",
  "",
  "class Meter:",
  "    def reset(self):",
  "        self.count = 0",
].join("\n");

const DOM_TS = [
  "export const make = () => ({ tag: 'x' });",
  "",
  "export function use() {",
  "  const s = 'make inside a string';",
  "  return make() && s;",
  "}",
].join("\n");

beforeAll(async () => {
  await tree.writeFile("/src/app.ts", APP_TS);
  await tree.writeFile("/src/tool.py", TOOL_PY);
  await tree.writeFile("/src/util.js", "export function twice(n) {\n  return n * 2;\n}\n");
  await tree.writeFile("/src/App.tsx", "export function App() {\n  return <div>hi</div>;\n}\n");
  await tree.writeFile("/src/refs/dom.ts", DOM_TS);
  await tree.writeFile("/notes/readme.md", "plain text, not code\n");
  await tree.writeFile("/deep/a/b/leaf.ts", "export const deep = 1;\n");
});

describe("code-intel tools", () => {
  it("both tools are ungated", () => {
    expect(tool("code_outline").gated).toBeUndefined();
    expect(tool("code_nav").gated).toBeUndefined();
  });

  it("code_outline draws the tree with symbols, skipping nothing here", async () => {
    const outline = await call("code_outline", {});
    expect(outline.isError).toBe(false);
    expect(outline.text).toContain("scope: . (7 file(s), 6 parsed)");
    expect(outline.text).toContain("src/");
    expect(outline.text).toContain("app.ts");
    expect(outline.text).toMatch(/fn greet:1/);
    expect(outline.text).toMatch(/class Greeter:\d/);
    expect(outline.text).toMatch(/method greet:\d/);
    expect(outline.text).toMatch(/const add:\d/);
    expect(outline.text).toMatch(/type Label:\d/);
    expect(outline.text).toMatch(/interface Named:\d/);
    expect(outline.text).toMatch(/fn clamp:1/);
    expect(outline.text).toMatch(/class Meter:\d/);
    expect(outline.text).toMatch(/method reset:\d/);
    expect(outline.text).toContain("readme.md");
    const structured = outline.structured as {
      scope: string;
      files: number;
      parsed: number;
      truncated: boolean;
      entries: { path: string; symbols: { name: string; kind: string; line: number }[] }[];
    };
    expect(structured.truncated).toBe(false);
    const app = structured.entries.find((entry) => entry.path === "src/app.ts");
    expect(app?.symbols.map((symbol) => symbol.name)).toContain("Greeter");
    expect(structured.entries.some((entry) => entry.path === "notes/readme.md")).toBe(false);
  });

  it("code_outline honours path and depth", async () => {
    const scoped = await call("code_outline", { path: "src" });
    expect(scoped.text).toContain("scope: src (5 file(s), 5 parsed)");
    expect(scoped.text).not.toContain("readme.md");
    const shallow = await call("code_outline", { path: "deep", depth: 1 });
    expect(shallow.text).toContain("a/");
    expect(shallow.text).not.toContain("leaf.ts");
  });

  it("code_outline skips dependency and build folders", async () => {
    await tree.writeFile("/node_modules/pkg/index.js", "module.exports = 1;\n");
    const outline = await call("code_outline", {});
    expect(outline.text).not.toContain("node_modules");
    expect(outline.text).not.toContain("pkg/index.js");
  });

  it("code_outline truncates with a hint", async () => {
    for (let f = 0; f < 30; f += 1) {
      const body = Array.from(
        { length: 40 },
        (_, i) => `function f${f}n${i}() {\n  return ${i};\n}\n`,
      ).join("\n");
      await tree.writeFile(`/big/lots-${f}.ts`, body);
    }
    const outline = await call("code_outline", { path: "big" });
    expect(outline.isError).toBe(false);
    expect(outline.text.length).toBeLessThan(6200);
    expect(outline.text).toContain("(truncated: narrow with path or depth)");
    expect((outline.structured as { truncated: boolean }).truncated).toBe(true);
  });

  it("both tools refuse unmapped chats, escapes, absolute paths and links", async () => {
    await tree.writeFile("/real/x.ts", "export const x = 1;\n");
    if (!(await tree.exists("/link"))) await tree.symlink("/real", "/link");
    for (const name of ["code_outline", "code_nav"]) {
      const base = name === "code_nav" ? { action: "definitions", name: "x" } : {};
      const unmapped = await call(name, { ...base, path: "x" }, "conv-none");
      expect(unmapped.text).toContain("refused: this chat belongs to no bot");
      for (const path of ["../owner-b/bot-1/x", "/etc/passwd", "link", "a/.."]) {
        const result = await call(name, { ...base, path });
        expect(result.isError, `${name} ${path}`).toBe(true);
        expect(result.text, `${name} ${path}`).toContain("refused");
      }
    }
  });

  it("code_nav finds definitions with excerpts", async () => {
    const found = await call("code_nav", { action: "definitions", name: "greet" });
    expect(found.isError).toBe(false);
    expect(found.text).toContain("src/app.ts:1  fn greet");
    expect(found.text).toContain("    export function greet(name: string): string {");
    expect(found.text).toContain('2 match(es) for "greet" (definitions)');
    expect(found.text).toContain("src/app.ts:6  method greet");
    expect((found.structured as { hits: unknown[] }).hits).toHaveLength(2);
    const scoped = await call("code_nav", { action: "definitions", name: "clamp", path: "src" });
    expect(scoped.text).toContain("src/tool.py:1  fn clamp");
  });

  it("code_nav references count code occurrences, never strings or comments", async () => {
    const refs = await call("code_nav", { action: "references", name: "make", path: "src/refs" });
    const lines = (refs.structured as { hits: { line: number }[] }).hits.map((hit) => hit.line);
    expect(lines).toEqual([1, 5]);
    expect(refs.text).toContain('2 match(es) for "make" (references)');
    expect(refs.text).toContain("    return make() && s;");
    expect(refs.text).not.toContain("make inside a string");
    const py = await call("code_nav", { action: "references", name: "clamp" });
    const pyLines = (py.structured as { hits: { line: number }[] }).hits.map((hit) => hit.line);
    expect(pyLines).toEqual([1]);
    expect(py.text).toContain("    def clamp(value, low, high):");
  });

  it("code_nav answers plainly when nothing parseable is under the scope", async () => {
    const none = await call("code_nav", { action: "definitions", name: "anything", path: "notes" });
    expect(none.isError).toBe(false);
    expect(none.text).toContain("no parseable code files here");
    expect(none.text).toContain("scope: notes (1 file(s), 0 parsed)");
  });

  it("code_nav reports zero matches as a count, not an error", async () => {
    const none = await call("code_nav", { action: "definitions", name: "nope" });
    expect(none.isError).toBe(false);
    expect(none.text).toContain('0 match(es) for "nope" (definitions)');
  });
});
