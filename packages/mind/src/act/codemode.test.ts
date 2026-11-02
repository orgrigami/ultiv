import { describe, expect, it } from "vite-plus/test";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createRegistry } from "@earendil-works/pi-durable";
import { checklistTools } from "../checklist/tools.ts";
import { questionTools } from "../ask/question.ts";
import { connectorTools } from "../mcp/connector-tools.ts";
import { manageTools } from "../mcp/manage-tools.ts";
import { codemodeExtension } from "./codemode.ts";

const sandboxWithDemoTool = async (): Promise<CodemodeSandbox> => {
  const sandbox = new CodemodeSandbox();
  sandbox.registerTool({
    name: "demo",
    description: "Returns the number doubled.",
    inputSchema: { type: "object", properties: { n: { type: "number" } } },
    outputSchema: { type: "object", properties: { value: { type: "number" } } },
    execute: async (args) => ({ value: ((args as { n?: number }).n ?? 0) * 2 }),
  });
  return sandbox;
};

describe("Codemode sandbox (real QuickJS)", () => {
  it("composes concurrent tool calls and returns the reduced value", async () => {
    const sandbox = await sandboxWithDemoTool();
    const result = await sandbox.execute(`
      const pairs = await Promise.all([tools.demo({ n: 1 }), tools.demo({ n: 2 }), tools.demo({ n: 3 })]);
      return pairs.map((pair) => pair.value).join("+");
    `);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value).toBe("2+4+6");
  });

  it("reads the seeded store and reports its own writes", async () => {
    const sandbox = await sandboxWithDemoTool();
    const read = await sandbox.execute(`return load("seen");`, { store: { seen: 41 } });
    if (!read.ok) throw new Error(read.error.message);
    expect(read.value).toBe(41);
    const write = await sandbox.execute(`store("k", [1, 2]); return "done";`);
    if (!write.ok) throw new Error(write.error.message);
    expect(write.storeWrites.set).toEqual({ k: [1, 2] });
  });

  it("surfaces script errors without throwing", async () => {
    const sandbox = await sandboxWithDemoTool();
    const result = await sandbox.execute(`throw new Error("no can do");`);
    if (result.ok) throw new Error("expected the script to fail");
    expect(result.error.message).toContain("no can do");
  });
});

describe("Codemode section listing", () => {
  /** A minimal registration with just what the section renderer reads. */
  const fakeTool = (name: string, description: string) => ({
    name,
    description,
    parameters: { type: "object", properties: { script: { type: "string" } } },
    execute: async () => ({ output: [{ type: "text", text: "ok" }] }),
  });

  it("always lists bash (all targets), however large the unnamespaced group", () => {
    const registry = createRegistry();
    registry.install(codemodeExtension());
    const entry = registry
      .snapshot()
      .sections()
      .find((candidate) => candidate.section.key === "codemode");
    if (entry === undefined) throw new Error("the codemode section is not installed");
    // Enough cheap filler to exhaust the inline budget many times over — the
    // shell is among the priciest declarations and dropped before the fix.
    const callable = [
      ...Array.from({ length: 40 }, (_, i) => fakeTool(`filler_${i}`, "Cheap filler tool.")),
      fakeTool(
        "bash",
        "Run a bash script in the sandboxed workspace VM, on the host, or on a node.",
      ),
    ];
    const text = entry.section.render({ agent: { callable } } as never, {} as never) ?? "";
    expect(text).toContain("## shell");
    expect(text).toMatch(/### `bash`/);
    expect(text).not.toContain("bash_host");
  });

  it("keeps the script-callable contract: reads and chat surfaces in, installs and org mutations out", () => {
    const audit = { record: () => undefined, tail: () => [] } as never;
    const callable = (tools: readonly { name?: string; callers?: readonly string[] }[]) =>
      Object.fromEntries(
        tools.map((tool) => [
          tool.name ?? "",
          tool.callers === undefined || tool.callers.includes("tools"),
        ]),
      );
    const contract = {
      ...callable(
        questionTools({
          approvals: audit,
          profiles: { scopeOf: () => undefined, profileOf: () => null },
          audit,
        } as never),
      ),
      ...callable(
        checklistTools({ converse: {}, profiles: { profileOf: () => undefined }, audit } as never),
      ),
      ...callable(
        connectorTools({
          manager: { list: () => [] },
          approvals: audit,
          audit,
          profiles: { profileOf: () => null },
          notes: [],
          callTimeoutMs: 1_000,
        } as never),
      ),
      ...callable(
        manageTools({
          manager: { list: () => [] },
          approvals: audit,
          audit,
          profiles: { profileOf: () => null },
          notes: [],
          callTimeoutMs: 1_000,
        } as never),
      ),
    };
    // Reads and the replay-safe chat surfaces compose inside a script.
    for (const name of ["connector_list", "ask_user_question", "checklist"]) {
      expect(contract[name], name).toBe(true);
    }
    // Installs with wrong interruption semantics stay model-direct: a script
    // may add or flip a connector (each change still parks its never-auto-
    // approved card), but connector_load pulls a live tool surface into the
    // conversation and codemode itself must not recurse.
    for (const name of ["connector_load"]) {
      expect(contract[name], name).toBe(false);
    }
    // Codemode itself is model-only: no scripts starting scripts.
    const registry = createRegistry();
    registry.install(codemodeExtension());
    const codemode = registry
      .snapshot()
      .tools()
      .find((row) => row.tool.name === "codemode");
    expect(codemode?.tool.callers).toEqual(["model"]);
  });
});
