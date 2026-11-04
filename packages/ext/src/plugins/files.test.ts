import { afterAll, describe, expect, it } from "vite-plus/test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableFs } from "../fs/durable-fs.ts";
import { bashPlugin, localShellBackend } from "./bash.ts";
import { writeArtifactBytes } from "./artifacts.ts";
import { filesPlugin, treePath } from "./files.ts";
import { createScopeHolder } from "./vault.ts";

const root = mkdtempSync(join(tmpdir(), "spriessen-files-"));
const outside = mkdtempSync(join(tmpdir(), "spriessen-files-outside-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const scopes: Record<string, { owner: string; profile: string }> = {
  "conv-a": { owner: "owner-a", profile: "bot-1" },
  "conv-b": { owner: "owner-b", profile: "bot-1" },
  "conv-linked": { owner: "owner-c", profile: "bot-1" },
};
const holder = createScopeHolder();
holder.set({ scopeOf: (cid) => scopes[cid] });

const plugin = filesPlugin({ root, holder });
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
const treeOf = (owner: string) => new DurableFs({ dir: join(root, owner, "bot-1") });

describe("file tools: the bot's own files", () => {
  it("reads open and gates changes", () => {
    expect(tool("file_read").gated).toBeUndefined();
    expect(tool("file_search").gated).toBeUndefined();
    expect(tool("file_edit").gated).toBe(true);
    expect(tool("file_delete").gated).toBe(true);
  });

  it("creates, edits, reads, searches and deletes by path", async () => {
    expect(
      (await call("file_edit", { path: "notes/plan.md", new_text: "alpha\nbeta\n" })).text,
    ).toBe("created notes/plan.md");
    const edited = await call("file_edit", {
      path: "notes/plan.md",
      old_text: "beta",
      new_text: "gamma",
    });
    expect(edited.text).toBe("changed notes/plan.md");
    expect((await call("file_read", { path: "notes/plan.md" })).text).toContain("2\tgamma");
    expect(
      (await call("file_read", { path: "notes/plan.md", start_line: 2, line_count: 1 })).text,
    ).toBe("# notes/plan.md (3 lines)\n2\tgamma");
    const found = await call("file_search", { query: "GAMMA" });
    expect(found.structured).toEqual([{ path: "notes/plan.md", lines: [2] }]);
    expect((await call("file_search", { query: "gamma", folder: "elsewhere" })).text).toBe(
      "no matches",
    );
    const twice = await call("file_edit", { path: "notes/plan.md", new_text: "a a" });
    expect(twice.isError).toBe(false);
    const ambiguous = await call("file_edit", {
      path: "notes/plan.md",
      old_text: "a",
      new_text: "b",
    });
    expect(ambiguous).toMatchObject({ isError: true });
    expect(ambiguous.text).toContain("2 times");
    expect((await call("file_delete", { path: "notes/plan.md" })).text).toBe(
      "deleted notes/plan.md",
    );
    expect((await call("file_read", { path: "notes/plan.md" })).isError).toBe(true);
    expect((await call("file_delete", { path: "notes" })).text).toContain("is a folder");
  });

  it("says binary files aren't text", async () => {
    await treeOf("owner-a").writeFile("/scan.pdf", new Uint8Array([37, 80, 68, 70, 0, 1, 2]));
    const read = await call("file_read", { path: "scan.pdf" });
    expect(read).toMatchObject({ isError: true });
    expect(read.text).toContain("extract_document_text");
  });

  const refusals: [string, Record<string, unknown>][] = [
    ["file_read", {}],
    ["file_search", { query: "x" }],
    ["file_find", { pattern: "x" }],
    ["file_edit", { new_text: "x" }],
    ["file_delete", {}],
    ["extract_document_text", {}],
  ];
  const pathKey = (name: string) => (name === "file_search" ? "folder" : "path");

  for (const [name, base] of refusals) {
    it(`${name} refuses .., absolute paths and links`, async () => {
      const tree = treeOf("owner-a");
      await tree.mkdir("/real", { recursive: true });
      await tree.writeFile("/real/x", "inside");
      if (!(await tree.exists("/via"))) await tree.symlink("/real", "/via");
      if (!(await tree.exists("/link-x"))) await tree.symlink("/real/x", "/link-x");
      for (const path of [
        "../owner-b/bot-1/x",
        "real/../../x",
        "/etc/passwd",
        "~/x",
        "C:/x",
        "a\\b",
        "via/x",
        "link-x",
      ]) {
        const result = await call(name, { ...base, [pathKey(name)]: path });
        expect(result.isError, `${name} ${path}`).toBe(true);
        expect(result.text, `${name} ${path}`).toContain("refused");
      }
      expect(await tree.readFile("/real/x", "utf8")).toBe("inside");
    });

    it(`${name} refuses a chat with no bot, and a bot folder linked outside`, async () => {
      const unmapped = await call(name, { ...base, [pathKey(name)]: "x" }, "conv-none");
      expect(unmapped.text).toContain("refused: this chat belongs to no bot");
      mkdirSync(join(root, "owner-c"), { recursive: true });
      try {
        symlinkSync(outside, join(root, "owner-c", "bot-1"));
      } catch {
        // already linked by an earlier case
      }
      writeFileSync(join(outside, "x"), "outside");
      const linked = await call(name, { ...base, [pathKey(name)]: "x" }, "conv-linked");
      expect(linked.text).toContain("refused: this bot's folder points outside");
    });
  }

  it("the wrong person can't read, change or delete another owner's file", async () => {
    await call("file_edit", { path: "mine.txt", new_text: "owner a only" });
    expect((await call("file_read", { path: "mine.txt" }, "conv-b")).text).toBe(
      "no file at mine.txt",
    );
    expect((await call("file_search", { query: "owner a" }, "conv-b")).text).toBe("no matches");
    expect((await call("file_delete", { path: "mine.txt" }, "conv-b")).text).toBe(
      "no file at mine.txt",
    );
    await call("file_edit", { path: "mine.txt", new_text: "owner b's own" }, "conv-b");
    expect((await call("file_read", { path: "mine.txt" })).text).toContain("owner a only");
  });

  it("bash sees a file_edit made after its VM loaded", async () => {
    const bash = bashPlugin({ root, holder, backend: (_dir, home) => localShellBackend(home) });
    const capability = bash.capabilities.find(
      (candidate) => candidate.kind === "tool" && candidate.tool.name === "bash",
    );
    if (capability?.kind !== "tool") throw new Error("missing bash");
    const run = (script: string) =>
      capability.tool.execute(
        { script } as never,
        { conversationId: "conv-a" } as never,
        {} as never,
      );
    await run("echo first > seen.txt");
    await call("file_edit", { path: "seen.txt", new_text: "second\n" });
    expect((await run("cat seen.txt")).structuredOutput).toMatchObject({ stdout: "second\n" });
    await call("file_delete", { path: "seen.txt" });
    // `test -e` exits 1 on every platform (a missing-file `ls` is 1 on macOS, 2 on Linux).
    expect((await run("test -e seen.txt")).structuredOutput).toMatchObject({ exitCode: 1 });
    expect((await call("file_read", { path: "seen.txt" })).isError).toBe(true);
  });
});

describe("extract_document_text", () => {
  const fixture = (name: string) =>
    readFileSync(new URL(`../docs/fixtures/${name}`, import.meta.url));
  it("is a read, and reads a PDF by path and a shared DOCX by artifact id", async () => {
    expect(tool("extract_document_text").gated).toBeUndefined();
    await treeOf("owner-a").mkdir("/in", { recursive: true });
    await treeOf("owner-a").writeFile("/in/plan.pdf", fixture("sample.pdf"));
    const pdf = await call("extract_document_text", { path: "in/plan.pdf" });
    expect(pdf.text).toContain("# in/plan.pdf (pdf)\nQuarterly plan for the test team.");
    const shared = writeArtifactBytes(join(root, "owner-a", "bot-1"), {
      name: "plan.docx",
      data: fixture("sample.docx"),
      owner: "owner-a",
      profile: "bot-1",
    });
    const docx = await call("extract_document_text", { artifact_id: shared.id });
    expect(docx.text).toContain("café and 3 < 4 & more.");
    // Another owner's bot can't read it by id.
    expect((await call("extract_document_text", { artifact_id: shared.id }, "conv-b")).text).toBe(
      `unknown artifact: ${shared.id}`,
    );
    expect(
      (await call("extract_document_text", { path: "x", artifact_id: shared.id })).isError,
    ).toBe(true);
  });
});

describe("file_find", () => {
  it("is open, matches names and paths, scopes and skips", async () => {
    expect(tool("file_find").gated).toBeUndefined();
    const tree = treeOf("owner-a");
    await tree.writeFile("/notes/report-2026.md", "alpha");
    await tree.writeFile("/notes/todo.txt", "beta");
    await tree.writeFile("/src/gen/one.py", "x = 1\n");
    const byName = await call("file_find", { pattern: "*.py" });
    expect(byName.text).toContain("src/gen/one.py");
    expect(byName.text).toContain('1 match(es) for "*.py"');
    const byPrefix = await call("file_find", { pattern: "report*" });
    expect(byPrefix.text).toContain("notes/report-2026.md");
    const scoped = await call("file_find", { pattern: "*", path: "notes" });
    expect(scoped.text).toContain("notes/todo.txt");
    expect(scoped.text).not.toContain("src/gen/one.py");
    const nested = await call("file_find", { pattern: "src/**/*.py" });
    expect(nested.text).toContain("src/gen/one.py");
    const question = await call("file_find", { pattern: "report-????.md" });
    expect(question.text).toContain("notes/report-2026.md");
    expect((await call("file_find", { pattern: "*.py", path: "notes" })).text).toBe("no matches");
    expect((await call("file_find", { pattern: "  " })).text).toContain("a pattern is required");
  });

  it("skips build and dependency folders, and caps at 100 paths", async () => {
    const tree = treeOf("owner-a");
    await tree.writeFile("/node_modules/pkg/index.js", "module.exports = 1;\n");
    expect((await call("file_find", { pattern: "index.js" })).text).toBe("no matches");
    for (let i = 0; i < 103; i += 1) await tree.writeFile(`/many/f${i}.txt`, "x");
    const capped = await call("file_find", { pattern: "f*.txt" });
    expect(capped.text.split("\n").filter((line) => line.startsWith("many/"))).toHaveLength(100);
    expect(capped.text).toContain('103 match(es) for "f*.txt", showing the first 100');
  });
});

describe("file_edit syntax notes", () => {
  it("appends a note for a broken code file, silence for clean or non-code files", async () => {
    const bad = await call("file_edit", { path: "src/broken.ts", new_text: "const x = ;\n" });
    expect(bad.text).toContain("created src/broken.ts");
    expect(bad.text).toContain("note: ");
    expect(bad.text).toContain("syntax error(s) detected, first at line 1");
    const good = await call("file_edit", { path: "src/clean.ts", new_text: "const y = 1;\n" });
    expect(good.text).toBe("created src/clean.ts");
    const changed = await call("file_edit", {
      path: "src/clean.ts",
      old_text: "const y = 1;",
      new_text: "const y = 2;",
    });
    expect(changed.text).toBe("changed src/clean.ts");
    const md = await call("file_edit", { path: "notes/plan2.md", new_text: "# plan\n" });
    expect(md.text).toBe("created notes/plan2.md");
  });
});

describe("treePath", () => {
  it("maps relative paths into the tree and refuses the rest", () => {
    expect(treePath("notes/a.md")).toEqual({ path: "/notes/a.md" });
    expect(treePath("notes/")).toEqual({ path: "/notes" });
    for (const bad of ["", "/a", "a//b", "./a", "a/..", "x\0y"])
      expect(treePath(bad)).toHaveProperty("refused");
  });
});
