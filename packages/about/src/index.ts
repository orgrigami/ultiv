/**
 * The app's self-knowledge, as first-party Agent Skills: one folder per
 * skill under `skills/`, each a SKILL.md with `name`/`description`
 * frontmatter and a markdown body. The mind ships these as the read-only
 * "built-in" tier of every bot's skill list; the same folders read fine in
 * any Agent Skills client. Content is bot-scale prose distilled from the
 * repo's docs; it ships with the app, so it cannot drift from it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface AboutSkill {
  /** The skill slug: the folder name. */
  readonly name: string;
  /** The raw SKILL.md text, frontmatter included. */
  readonly markdown: string;
}

/** Reading order for the built-in library (currently one whole-world skill). */
const ORDER = ["ultiv"];

let cached: readonly AboutSkill[] | null = null;

/** The built-in skills, folder name + raw SKILL.md, in display order. */
export const aboutSkills = (): readonly AboutSkill[] => {
  if (cached !== null) return cached;
  const root = fileURLToPath(new URL("../skills/", import.meta.url));
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const rank = new Map(ORDER.map((name, at) => [name, at]));
  cached = dirs
    .map((name) => ({ name, markdown: readFileSync(`${root}${name}/SKILL.md`, "utf8") }))
    .sort(
      (a, b) =>
        (rank.get(a.name) ?? ORDER.length) - (rank.get(b.name) ?? ORDER.length) ||
        a.name.localeCompare(b.name),
    );
  return cached;
};
