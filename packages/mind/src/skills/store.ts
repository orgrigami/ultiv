/**
 * The skill store: per-profile folders on disk, one index file per profile.
 * Layout: `{root}/{owner}/{profile}/skills/<name>/SKILL.md` plus any extra
 * reference files, with `skills.index.json` holding the metadata (including
 * each skill's previous version, so a revert is a file rewrite, not
 * archaeology). Built-in skills (the app's own) are merged into listings but
 * live in the package, never on disk: they are read-only by construction.
 * Plain sync fs, like the artifacts store; throws Error with plain text the
 * tools relay.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillMeta, SkillOrigin } from "@ultiv/contracts";
import {
  MAX_DESCRIPTION_CHARS,
  MAX_SKILL_CHARS,
  MAX_SKILL_FILE_CHARS,
  MAX_SKILL_FILES,
  MAX_SKILL_FILES_BYTES,
  relativePathOk,
  secretIn,
  slugOk,
} from "./guard.ts";
import { parseSkillDoc, serializeSkillDoc } from "./frontmatter.ts";

/** A skill that ships with the app: parsed once, merged into every listing. */
export interface BuiltinSkill {
  readonly name: string;
  readonly description: string;
  readonly markdown: string;
  /** Reference files the package carries beside the SKILL.md. */
  readonly files: readonly { readonly path: string; readonly content: string }[];
}

interface StoredSkill extends SkillMeta {
  previous: { version: number; body: string } | null;
}

interface ProfileIndex {
  skills: Record<string, StoredSkill>;
  builtins: Record<string, { enabled: boolean }>;
}

const EMPTY_INDEX: ProfileIndex = { skills: {}, builtins: {} };

/** The store root (relative to the server's cwd, like ARTIFACTS_DIR). */
export const skillsDir = (): string => {
  const configured = process.env.SKILLS_DIR?.trim();
  return configured !== undefined && configured !== "" ? configured : "var/skills";
};

const scopeDir = (root: string, owner: string, profile: string): string => {
  for (const segment of [owner, profile]) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(segment)) {
      throw new Error(`bad scope segment "${segment}"`);
    }
  }
  return join(root, owner, profile);
};

const skillsOf = (root: string, owner: string, profile: string): string =>
  join(scopeDir(root, owner, profile), "skills");

const indexFile = (root: string, owner: string, profile: string): string =>
  join(scopeDir(root, owner, profile), "skills.index.json");

const readIndex = (root: string, owner: string, profile: string): ProfileIndex => {
  const file = indexFile(root, owner, profile);
  if (!existsSync(file)) return EMPTY_INDEX;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ProfileIndex>;
    return { skills: raw.skills ?? {}, builtins: raw.builtins ?? {} };
  } catch {
    return EMPTY_INDEX;
  }
};

const writeIndex = (root: string, owner: string, profile: string, index: ProfileIndex): void => {
  mkdirSync(scopeDir(root, owner, profile), { recursive: true });
  writeFileSync(indexFile(root, owner, profile), JSON.stringify(index, null, "\t"));
};

/** Files beside SKILL.md, relative paths, sorted ([] when the folder is gone). */
/** Paths under the skills dir (relative to it), SKILL.md roots excluded. */
const extraFiles = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  const walk = (rel: string): string[] =>
    readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === "SKILL.md" && rel === "") return [];
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      return entry.isDirectory() ? walk(path) : [path];
    });
  return walk("").sort();
};

const builtinMeta = (skill: BuiltinSkill, enabled: boolean): SkillMeta => ({
  name: skill.name,
  description: skill.description,
  origin: "builtin",
  sourceUrl: null,
  authorProfile: null,
  createdAt: 0,
  updatedAt: 0,
  version: 1,
  enabled,
  files: skill.files.map((file) => file.path),
  parentVersion: null,
  evolutionNote: null,
});

/** All skills for one profile: built-ins first (display order), then newest writes. */
export const listSkills = (
  root: string,
  owner: string,
  profile: string,
  builtins: readonly BuiltinSkill[],
): SkillMeta[] => {
  const index = readIndex(root, owner, profile);
  const builtinMetas = builtins.map((skill) =>
    builtinMeta(skill, index.builtins[skill.name]?.enabled ?? true),
  );
  const stored = Object.values(index.skills)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(({ previous: _previous, ...meta }) => meta);
  return [...builtinMetas, ...stored];
};

export interface SkillRead {
  readonly meta: SkillMeta;
  readonly body: string;
}

const readStoredBody = (
  root: string,
  owner: string,
  profile: string,
  name: string,
): string | undefined => {
  const file = join(skillsOf(root, owner, profile), name, "SKILL.md");
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
};

/** One skill's meta + body; built-ins resolve from their package markdown. */
export const readSkill = (
  root: string,
  owner: string,
  profile: string,
  name: string,
  builtins: readonly BuiltinSkill[],
): SkillRead | undefined => {
  const index = readIndex(root, owner, profile);
  const builtin = builtins.find((skill) => skill.name === name);
  if (builtin !== undefined) {
    return {
      meta: builtinMeta(builtin, index.builtins[name]?.enabled ?? true),
      body: builtin.markdown,
    };
  }
  const stored = index.skills[name];
  const body = readStoredBody(root, owner, profile, name);
  if (stored === undefined || body === undefined) return undefined;
  const { previous: _previous, ...meta } = stored;
  return { meta, body };
};

/** One skill's extra file, capped; traversal-shaped paths are refused.
 * Built-ins resolve from the package, never disk. */
export const readSkillFile = (
  root: string,
  owner: string,
  profile: string,
  name: string,
  rel: string,
  builtins: readonly BuiltinSkill[] = [],
): string | undefined => {
  if (!relativePathOk(rel)) return undefined;
  const builtin = builtins.find((skill) => skill.name === name);
  if (builtin !== undefined) {
    const file = builtin.files.find((candidate) => candidate.path === rel);
    return file?.content;
  }
  const file = join(skillsOf(root, owner, profile), name, rel);
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf8");
  return text.length > MAX_SKILL_FILE_CHARS ? text.slice(0, MAX_SKILL_FILE_CHARS) : text;
};

export interface SkillFileIn {
  /** Path relative to the skill folder (references/, scripts/, assets/…). */
  readonly path: string;
  readonly content: string;
}

export interface SkillWrite {
  readonly name: string;
  readonly body: string;
  readonly origin: SkillOrigin;
  readonly sourceUrl?: string | null;
  readonly authorProfile?: string | null;
  readonly parentVersion?: number | null;
  readonly note?: string | null;
  /**
   * The skill's COMPLETE reference set: given files are written, extras on
   * disk are pruned. Undefined leaves the current files untouched.
   */
  readonly files?: readonly SkillFileIn[];
}

/**
 * The skill folder's reference files, full-set: validate (path, size, text,
 * secrets), write every given file, prune anything not given. Returns the
 * stored list, relative to the skill folder.
 */
const applySkillFiles = (dir: string, name: string, files: readonly SkillFileIn[]): string[] => {
  if (files.length > MAX_SKILL_FILES) {
    throw new Error(`a skill carries at most ${MAX_SKILL_FILES} reference files`);
  }
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (!relativePathOk(file.path) || file.path === "SKILL.md") {
      throw new Error(`not a skill file path: "${file.path}"`);
    }
    if (seen.has(file.path)) throw new Error(`duplicate file: ${file.path}`);
    seen.add(file.path);
    if (file.content.length > MAX_SKILL_FILE_CHARS) {
      throw new Error(`"${file.path}" exceeds ${MAX_SKILL_FILE_CHARS} chars`);
    }
    if (file.content.includes("\0")) {
      throw new Error(`"${file.path}" is binary; skill files are text`);
    }
    const secret = secretIn(file.content);
    if (secret !== null) {
      throw new Error(`refused: "${file.path}" looks like it contains ${secret}`);
    }
    total += file.content.length;
    if (total > MAX_SKILL_FILES_BYTES) {
      throw new Error(`reference files exceed ${MAX_SKILL_FILES_BYTES} bytes in total`);
    }
  }
  const skillDir = join(dir, name);
  for (const file of files) {
    const target = join(skillDir, file.path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, file.content, "utf8");
  }
  // Prune stored extras that the new set does not carry (full-set semantics).
  for (const existing of extraFiles(dir)) {
    const rel = existing.slice(name.length + 1);
    if (existing.startsWith(`${name}/`) && !seen.has(rel)) {
      rmSync(join(skillDir, rel), { recursive: true, force: true });
    }
  }
  return [...seen];
};

/**
 * Create or update a skill: validates slug/size/secrets/frontmatter (the
 * stored frontmatter name is normalized to the folder name, as the spec
 * requires), keeps the previous body for revert, applies the reference set.
 * Built-ins refuse.
 */
export const writeSkill = (
  root: string,
  owner: string,
  profile: string,
  input: SkillWrite,
  builtins: readonly BuiltinSkill[],
): SkillMeta => {
  if (!slugOk(input.name))
    throw new Error(`not a skill name: "${input.name}" (lowercase-and-hyphens, at most 64)`);
  if (input.body.length > MAX_SKILL_CHARS) {
    throw new Error(`skill body exceeds ${MAX_SKILL_CHARS} chars; split it or tighten it`);
  }
  if (builtins.some((skill) => skill.name === input.name)) {
    throw new Error(`"${input.name}" is a built-in skill: read-only, it updates with the app`);
  }
  const secret = secretIn(input.body);
  if (secret !== null) {
    throw new Error(
      `refused: the body looks like it contains ${secret}; skills never carry secrets`,
    );
  }
  const doc = parseSkillDoc(input.body);
  if (doc === undefined) {
    throw new Error(
      "the body needs frontmatter: ---\\nname: …\\ndescription: …\\n--- above the markdown",
    );
  }
  if (doc.description.length > MAX_DESCRIPTION_CHARS) {
    throw new Error(`description exceeds ${MAX_DESCRIPTION_CHARS} chars`);
  }
  // The spec requires frontmatter name == folder name; normalize silently.
  const body =
    doc.name === input.name ? input.body : serializeSkillDoc(input.name, doc.description, doc.body);
  const index = readIndex(root, owner, profile);
  const existing = index.skills[input.name];
  const now = Date.now();
  const stored: StoredSkill = {
    name: input.name,
    description: doc.description,
    origin: input.origin,
    sourceUrl: input.sourceUrl ?? existing?.sourceUrl ?? null,
    authorProfile: input.authorProfile ?? existing?.authorProfile ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    version: (existing?.version ?? 0) + 1,
    enabled: existing?.enabled ?? true,
    files:
      input.files === undefined
        ? (existing?.files ?? [])
        : applySkillFiles(skillsOf(root, owner, profile), input.name, input.files),
    parentVersion: input.parentVersion ?? null,
    evolutionNote: input.note ?? null,
    previous:
      existing === undefined
        ? null
        : {
            version: existing.version,
            body: readStoredBody(root, owner, profile, input.name) ?? "",
          },
  };
  const dir = skillsOf(root, owner, profile);
  mkdirSync(join(dir, input.name), { recursive: true });
  writeFileSync(join(dir, input.name, "SKILL.md"), body, "utf8");
  index.skills[input.name] = stored;
  writeIndex(root, owner, profile, index);
  const { previous: _previous, ...meta } = stored;
  return meta;
};

/** Remove one stored skill (folder + index row); built-ins and unknowns refuse. */
export const removeSkill = (
  root: string,
  owner: string,
  profile: string,
  name: string,
  builtins: readonly BuiltinSkill[],
): boolean => {
  if (builtins.some((skill) => skill.name === name)) {
    throw new Error(`"${name}" is a built-in skill: read-only`);
  }
  const index = readIndex(root, owner, profile);
  if (index.skills[name] === undefined) return false;
  rmSync(join(skillsOf(root, owner, profile), name), { recursive: true, force: true });
  delete index.skills[name];
  writeIndex(root, owner, profile, index);
  return true;
};

/** Enable or disable a skill for one profile (built-ins too). */
export const setSkillEnabled = (
  root: string,
  owner: string,
  profile: string,
  name: string,
  enabled: boolean,
  builtins: readonly BuiltinSkill[],
): SkillMeta | undefined => {
  const index = readIndex(root, owner, profile);
  if (builtins.some((skill) => skill.name === name)) {
    index.builtins[name] = { enabled };
    writeIndex(root, owner, profile, index);
    const builtin = builtins.find((skill) => skill.name === name);
    return builtin === undefined ? undefined : builtinMeta(builtin, enabled);
  }
  const stored = index.skills[name];
  if (stored === undefined) return undefined;
  stored.enabled = enabled;
  stored.updatedAt = Date.now();
  index.skills[name] = stored;
  writeIndex(root, owner, profile, index);
  const { previous: _previous, ...meta } = stored;
  return meta;
};

/** Restore a skill's previous body (version bumped again, lineage noted). */
export const revertSkill = (
  root: string,
  owner: string,
  profile: string,
  name: string,
  builtins: readonly BuiltinSkill[],
): SkillMeta | undefined => {
  const index = readIndex(root, owner, profile);
  const stored = index.skills[name];
  if (stored === undefined || stored.previous === null || stored.previous.body === "") {
    return undefined;
  }
  return writeSkill(
    root,
    owner,
    profile,
    {
      name,
      body: stored.previous.body,
      origin: stored.origin,
      sourceUrl: stored.sourceUrl,
      authorProfile: stored.authorProfile,
      parentVersion: stored.previous.version,
      note: `reverted from v${stored.version} to v${stored.previous.version}`,
    },
    builtins,
  );
};
