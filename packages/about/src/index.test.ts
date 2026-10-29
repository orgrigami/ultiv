import { describe, expect, it } from "vite-plus/test";
import { aboutSkills } from "./index.ts";

/** The same frontmatter shape the mind's parser accepts, checked locally. */
const parse = (markdown: string): { name: string; description: string } | undefined => {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(markdown);
  if (match === null) return undefined;
  let name = "";
  let description = "";
  for (const line of (match[1] ?? "").split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const value = line
      .slice(at + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1");
    if (key === "name") name = value;
    if (key === "description") description = value;
  }
  return name !== "" && description !== "" ? { name, description } : undefined;
};

describe("aboutSkills", () => {
  it("ships the built-in library in display order", () => {
    expect(aboutSkills().map((skill) => skill.name)).toEqual(["ultiv"]);
  });

  it("every skill parses and stays within the store's cap", () => {
    for (const skill of aboutSkills()) {
      const doc = parse(skill.markdown);
      expect(doc, skill.name).toBeDefined();
      expect(doc?.name).toBe(skill.name);
      expect(doc?.description.length).toBeGreaterThan(10);
      expect(skill.markdown.length).toBeLessThanOrEqual(20_000);
    }
  });

  it("built-in bodies keep the house style: no em dashes", () => {
    for (const skill of aboutSkills()) {
      expect(skill.markdown.includes("—"), `${skill.name} contains an em dash`).toBe(false);
    }
  });
});
