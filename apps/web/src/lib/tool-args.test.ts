/**
 * Tool cards read the arguments the tools really take. The tools live in
 * another package, so these tests pin the parameter names the cards read
 * (a card reading `command` while the tool takes `script` showed an empty
 * script box) and check each card against a call in the real shape.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import type { ToolStep } from "@spriessen/contracts";
import { errorTextOf, outputBesidesError, presentationOf } from "./tool-text.ts";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string): string =>
  readFileSync(join(here, "../../../../packages/ext/src/plugins", path), "utf8");

const step = (over: Partial<ToolStep>): ToolStep => ({
  callId: "c1",
  name: "bash",
  status: "done",
  input: {},
  output: null,
  durationMs: 1200,
  ...over,
});

const viewOf = (over: Partial<ToolStep>) => {
  const presented = presentationOf(step(over));
  if (presented.kind !== "human") throw new Error("hidden");
  return presented.view;
};

describe("the arguments the tools take", () => {
  it("the shell tool takes `script` and the target enum", () => {
    const bash = source("bash.ts");
    expect(bash).toMatch(/const BashParams = Type\.Object\(\{\s*script: Type\.String/);
    expect(bash).toMatch(/BASH_TARGETS\.map\(\(target\) => Type\.Literal\(target\)\)/);
  });

  it("web_fetch takes `urls` and answers `pages`", () => {
    const web = source("tinyfish.ts");
    expect(web).toMatch(/const FetchInput = Type\.Object\(\{\s*urls: Type\.Array/);
    expect(web).toMatch(/const FetchOutput = Type\.Object\(\{\s*pages: Type\.Array/);
  });

  it("artifact_read takes only an id and answers with a # name heading", () => {
    const artifacts = source("artifacts.ts");
    expect(artifacts).toContain(
      'parameters: Type.Object({ id: Type.String({ description: "The artifact id." }) })',
    );
    expect(artifacts).toContain("text: `# ${found.info.name}\\n\\n${found.text}`");
  });
});

describe("shell cards", () => {
  const script = "set -e\ndf -h /\necho done";

  it("show the script as written, wherever the call ran", () => {
    for (const input of [
      { script },
      { script, target: "host" },
      { script, target: "node", node: "node-x" },
    ]) {
      const view = viewOf({ name: "bash", input, output: "overlay 3.9G 60K 3.9G 1% /" });
      expect(view.detail).toBe("set -e df -h / echo done");
      expect(view.structured).toEqual({
        t: "term",
        command: script,
        output: "overlay 3.9G 60K 3.9G 1% /",
      });
    }
    expect(viewOf({ name: "bash", input: { script } }).done).toBe(
      "Ran a script in its workspace VM",
    );
    expect(viewOf({ name: "bash", input: { script, target: "host" } }).done).toBe(
      "Ran a script on the host",
    );
    expect(viewOf({ name: "bash", input: { script, target: "node", node: "node-x" } }).done).toBe(
      "Ran a script on node node-x",
    );
  });

  it("still read `command` from older stored calls", () => {
    expect(viewOf({ input: { command: "ls" } }).structured).toMatchObject({ command: "ls" });
  });

  it("don't repeat a refusal as the output", () => {
    const refusal =
      "too complex to judge: split into smaller steps — 6 chained commands in one call. Retry as smaller, single-purpose calls.";
    const refused = step({ status: "error", input: { script }, output: refusal });
    expect(errorTextOf(refused)).toBe(refusal);
    expect(outputBesidesError(refused)).toBeUndefined();
    expect(viewOf({ status: "error", input: { script }, output: refusal }).structured).toEqual({
      t: "term",
      command: script,
      output: "",
    });
  });

  it("don't repeat an error that came back as { error } JSON", () => {
    const failed = step({
      status: "error",
      output: JSON.stringify({ error: "No such file: a.csv" }),
    });
    expect(errorTextOf(failed)).toBe("No such file: a.csv");
    expect(outputBesidesError(failed)).toBeUndefined();
    const more = step({ status: "error", output: JSON.stringify({ error: "denied", code: 403 }) });
    expect(outputBesidesError(more)).toBe(JSON.stringify({ error: "denied", code: 403 }));
  });

  it("keep a failed script's output when it says more than the error line", () => {
    const failed = step({ status: "error", input: { script }, output: "exit 1\nno such file" });
    expect(outputBesidesError(failed)).toBe("exit 1\nno such file");
  });
});

describe("web and file cards", () => {
  it("web_fetch shows the page it read", () => {
    const view = viewOf({
      name: "web_fetch",
      input: { urls: ["https://example.com/docs", "https://example.org/b"] },
      output: JSON.stringify({ pages: [{ url: "https://example.com/docs", content: "# Docs" }] }),
    });
    expect(view.done).toBe("Read 2 web pages");
    expect(view.detail).toBe("example.com +1");
    expect(view.structured).toEqual({
      t: "page",
      url: "https://example.com/docs",
      host: "example.com",
      text: "# Docs",
    });
  });

  it("artifact_read names the file and shows its text", () => {
    const view = viewOf({
      name: "artifact_read",
      input: { id: "a1" },
      output: "# notes.md\n\nline one",
    });
    expect(view.detail).toBe("notes.md");
    expect(view.structured).toEqual({ t: "file", name: "notes.md", text: "line one" });
    expect(view.artifact).toBeUndefined();
  });
});
