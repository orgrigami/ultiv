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
    expect(aboutSkills().map((skill) => skill.name)).toEqual(["spreissen"]);
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

  it("reference files ride along, readable and within caps", () => {
    const spreissen = aboutSkills().find((skill) => skill.name === "spreissen");
    expect(spreissen?.files.map((file) => file.path)).toEqual([
      "references/mind.md",
      "references/platform.md",
      "references/procedures.md",
      "references/surfaces.md",
    ]);
    for (const file of spreissen?.files ?? []) {
      expect(file.content.length).toBeGreaterThan(100);
      expect(file.content.length).toBeLessThanOrEqual(100_000);
      expect(file.content.includes("\0")).toBe(false);
    }
  });

  it("built-in texts keep the house style: no em dashes", () => {
    for (const skill of aboutSkills()) {
      expect(skill.markdown.includes("—"), `${skill.name} contains an em dash`).toBe(false);
      for (const file of skill.files) {
        expect(file.content.includes("—"), `${skill.name}/${file.path}`).toBe(false);
      }
    }
  });
});
