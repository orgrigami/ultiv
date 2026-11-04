/**
 * The built-in skill against the app it describes. The skill ships with the
 * app, but prose still drifts: these checks fail when it names a tool that
 * no package defines, misses a place in the navigation, or brings back a
 * description the app has since dropped.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { aboutSkills } from "./index.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "node_modules" ? [] : sources(path);
    return entry.endsWith(".ts") && !entry.endsWith(".test.ts") ? [path] : [];
  });

/** Every tool name a package defines (`defineTool({ name: ... })` with constants
 *  resolved, plus plain `ToolRegistration` returns). */
function shippedToolNames(): Set<string> {
  const texts = readdirSync(join(repo, "packages")).flatMap((pkg) => {
    try {
      return sources(join(repo, "packages", pkg, "src")).map((path) => readFileSync(path, "utf8"));
    } catch {
      return [];
    }
  });
  const constants = new Map<string, string>();
  for (const text of texts) {
    for (const match of text.matchAll(/export const ([A-Z_]+) = "([a-z_]+)"/g)) {
      constants.set(match[1]!, match[2]!);
    }
  }
  const names = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(
      /defineTool\(\s*\{(?:\s*\/\/[^\n]*)*\s*name:\s*(?:"([a-z_]+)"|([A-Z_]+))/g,
    )) {
      const name = match[1] ?? constants.get(match[2]!);
      if (name !== undefined) names.add(name);
    }
    // Plain registrations (the Jev tools): `ToolRegistration<…> { return { name: "…"`.
    for (const match of text.matchAll(
      /ToolRegistration<[^>]*>\s*\{\s*return\s*\{\s*name:\s*"([a-z_]+)"/g,
    )) {
      names.add(match[1]!);
    }
  }
  return names;
}

const allText = (): string =>
  aboutSkills()
    .flatMap((skill) => [skill.markdown, ...skill.files.map((file) => file.content)])
    .join("\n");

/** Backticked words that look like tool names: snake_case, or a known one-word tool. */
const ONE_WORD_TOOLS = new Set(["bash", "graph", "checklist", "message", "room", "now", "jev"]);
const namedTools = (text: string): string[] =>
  [...text.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)*)`/g)]
    .map((match) => match[1]!)
    .filter((word) => word.includes("_") || ONE_WORD_TOOLS.has(word));

describe("the built-in skill matches the app", () => {
  it("names only tools a package defines", () => {
    const shipped = shippedToolNames();
    expect(shipped.size).toBeGreaterThan(50);
    const unknown = [...new Set(namedTools(allText()))].filter((name) => !shipped.has(name));
    expect(unknown).toEqual([]);
  });

  it("names every place in the navigation", () => {
    const nav = readFileSync(join(repo, "apps/web/src/lib/nav.ts"), "utf8");
    const block = /SECTION_LABEL[^{]*\{([^}]*)\}/.exec(nav)?.[1] ?? "";
    const labels = [...block.matchAll(/:\s*"([^"]+)"/g)].map((match) => match[1]!);
    expect(labels.length).toBe(5);
    const surfaces = aboutSkills()[0]?.files.find((file) => file.path === "references/surfaces.md");
    for (const label of labels) expect(surfaces?.content, label).toContain(`**${label}**`);
  });

  it("does not bring back what the app dropped", () => {
    const text = allText();
    for (const stale of [
      "seat conversation", // rooms are tunnels between the bots' own threads
      "drop a line into", // owners read bot talks, never post in them
    ]) {
      expect(text.includes(stale), stale).toBe(false);
    }
    // Old place names, in the places reference ("History" stays a faculty).
    const surfaces = aboutSkills()[0]?.files.find((file) => file.path === "references/surfaces.md");
    for (const stale of ["**Bots**", "**Approvals**", "**History**"]) {
      expect(surfaces?.content.includes(stale), stale).toBe(false);
    }
  });
});
