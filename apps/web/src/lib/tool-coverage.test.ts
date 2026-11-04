/**
 * Drift guard between the tools the packages ship and the words the web has
 * for them. It reads every `defineTool({ name: … })` under packages/*\/src
 * (constants resolved), so a new tool fails here until it has:
 *  - its own words in the presentation lens (not the humanized fallback),
 *    or is deliberately hidden there;
 *  - when it is `gated`, its own approval-card words (the name-based guess
 *    called a skill install "lower risk" once).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { hasOwnWords } from "./approval-text.ts";
import { humanizeToolName, presentationOf } from "./tool-text.ts";

const packages = join(dirname(fileURLToPath(import.meta.url)), "../../../../packages");

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "node_modules" ? [] : sources(path);
    return entry.endsWith(".ts") && !entry.endsWith(".test.ts") ? [path] : [];
  });

type Shipped = { readonly name: string; readonly gated: boolean };

function shippedTools(): Shipped[] {
  const files = readdirSync(packages).flatMap((pkg) => {
    const src = join(packages, pkg, "src");
    try {
      return sources(src).map((path) => readFileSync(path, "utf8"));
    } catch {
      return [];
    }
  });
  const constants = new Map<string, string>();
  for (const text of files) {
    for (const match of text.matchAll(/export const ([A-Z_]+) = "([a-z_]+)"/g)) {
      constants.set(match[1]!, match[2]!);
    }
  }
  const tools: Shipped[] = [];
  for (const text of files) {
    const blocks = text.split(/defineTool\(\s*\{/).slice(1);
    for (const block of blocks) {
      // Leading comments are allowed between `defineTool({` and `name:`.
      const named = /^(?:\s*\/\/[^\n]*)*\s*name:\s*(?:"([a-z_]+)"|([A-Z_]+))\s*,/.exec(block);
      if (named === null) continue; // a computed name (connector_${change}): covered by hand
      const name = named[1] ?? constants.get(named[2]!);
      if (name === undefined) continue;
      const head = block.split(/\bexecute\b/)[0] ?? "";
      tools.push({ name, gated: /\bgated:\s*true\b/.test(head) });
    }
  }
  // Plain registrations (the Jev tools) are never gated: they only judge.
  for (const text of files) {
    for (const match of text.matchAll(
      /ToolRegistration<[^>]*>\s*\{\s*return\s*\{\s*name:\s*"([a-z_]+)"/g,
    )) {
      tools.push({ name: match[1]!, gated: false });
    }
  }
  return tools;
}

const tools = shippedTools();

const stepOf = (name: string) => ({
  callId: "c1",
  name,
  status: "done" as const,
  input: {},
  output: null,
  durationMs: null,
});

describe("every shipped tool reads in owner words", () => {
  it("finds the tools (the scan itself works)", () => {
    expect(tools.length).toBeGreaterThan(50);
    expect(tools.find((tool) => tool.name === "bash")?.gated).toBe(true);
    expect(tools.find((tool) => tool.name === "file_read")?.gated).toBe(false);
    expect(tools.find((tool) => tool.name === "skill_install")?.gated).toBe(true);
    expect(tools.some((tool) => tool.name === "ask_user_question")).toBe(true);
    expect(tools.some((tool) => tool.name === "bots_list")).toBe(true); // a comment precedes its name
    expect(tools.some((tool) => tool.name === "jev_score")).toBe(true); // a plain registration
  });

  it("has its own words in the lens, or is deliberately hidden", () => {
    const fallback = tools
      .map((tool) => tool.name)
      .filter((name) => {
        const shown = presentationOf(stepOf(name));
        return shown.kind === "human" && shown.view.done === humanizeToolName(name);
      });
    expect(fallback).toEqual([]);
  });

  it("has its own approval-card words when gated", () => {
    const unworded = tools.filter((tool) => tool.gated && !hasOwnWords(tool.name));
    expect(unworded.map((tool) => tool.name)).toEqual([]);
  });
});
