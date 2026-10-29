/**
 * The app's self-knowledge, as first-party Agent Skills: one folder per
 * skill under `skills/`, each a SKILL.md with `name`/`description`
 * frontmatter and a markdown body, plus any reference files the folder
 * carries (read on demand, the spec's progressive disclosure). The mind
 * ships these as the read-only "built-in" tier of every bot's skill list;
 * the same folders read fine in any Agent Skills client. Content is
 * bot-scale prose distilled from the repo's docs; it ships with the app,
 * so it cannot drift from it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface AboutFile {
  /** Path relative to the skill folder (references/, scripts/, …). */
  readonly path: string;
  readonly content: string;
}

export interface AboutSkill {
  /** The skill slug: the folder name. */
  readonly name: string;
  /** The raw SKILL.md text, frontmatter included. */
  readonly markdown: string;
  /** Every other text file in the folder, SKILL.md excluded. */
  readonly files: readonly AboutFile[];
}

/** Reading order for the built-in library (currently one whole-world skill). */
const ORDER = ["ultiv"];

const readFiles = (dir: string): AboutFile[] => {
  const walk = (rel: string): AboutFile[] =>
    readdirSync(`${dir}${rel === "" ? "" : `/${rel}`}`, { withFileTypes: true }).flatMap(
      (entry): AboutFile[] => {
        if (entry.name === "SKILL.md" && rel === "") return [];
        const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) return walk(path);
        return [{ path, content: readFileSync(`${dir}/${path}`, "utf8") }];
      },
    );
  return walk("").sort((a, b) => a.path.localeCompare(b.path));
};

let cached: readonly AboutSkill[] | null = null;

/** The built-in skills: folder name, SKILL.md text, and reference files. */
export const aboutSkills = (): readonly AboutSkill[] => {
  if (cached !== null) return cached;
  const root = fileURLToPath(new URL("../skills/", import.meta.url));
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const rank = new Map(ORDER.map((name, at) => [name, at]));
  cached = dirs
    .map((name) => ({
      name,
      markdown: readFileSync(`${root}${name}/SKILL.md`, "utf8"),
      files: readFiles(`${root}${name}`),
    }))
    .sort(
      (a, b) =>
        (rank.get(a.name) ?? ORDER.length) - (rank.get(b.name) ?? ORDER.length) ||
        a.name.localeCompare(b.name),
    );
  return cached;
};
