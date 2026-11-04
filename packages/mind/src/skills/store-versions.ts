/**
 * A skill's version history on disk: list its versions, restore one as a new
 * version, and revert to the one before.
 */

import type { SkillMeta } from "@spriessen/contracts";
import { historyOf, type Version, type VersionAuthor } from "../versions/store.ts";

import { legacyHistory, readIndex, readStoredBody, versionsOf, writeSkill } from "./store.ts";
import type { BuiltinSkill } from "./store.ts";

/**
 * One stored skill's history, oldest first. Built-ins have none. A skill
 * from before full history shows its two kept versions. A removed skill's
 * history stays readable (restore, undo and the owner's surface read it),
 * though nothing lists the skill itself.
 */
export const skillVersions = (
  root: string,
  owner: string,
  profile: string,
  name: string,
): Version[] => {
  const stored = readIndex(root, owner, profile).skills[name];
  if (stored === undefined) return historyOf(versionsOf(root, owner, profile), name);
  const history = historyOf(versionsOf(root, owner, profile), name);
  return history.length > 0
    ? history
    : legacyHistory(stored, readStoredBody(root, owner, profile, name) ?? "");
};

/**
 * Make version `n` current again as a new version (history is never
 * rewritten): SKILL.md and, when the version recorded them, the folder's
 * other files (the complete set: extras are pruned). A version from before
 * files were versioned leaves the current files as they are.
 */
export const restoreSkillVersion = (
  root: string,
  owner: string,
  profile: string,
  name: string,
  n: number,
  by: VersionAuthor,
  builtins: readonly BuiltinSkill[],
  reason: string = `Restored version ${n}`,
): SkillMeta | undefined => {
  const stored = readIndex(root, owner, profile).skills[name];
  const old = skillVersions(root, owner, profile, name).find((version) => version.n === n);
  if (stored === undefined || old === undefined || old.text === "") return undefined;
  return writeSkill(
    root,
    owner,
    profile,
    {
      name,
      body: old.text,
      origin: stored.origin,
      sourceUrl: stored.sourceUrl,
      authorProfile: stored.authorProfile,
      parentVersion: n,
      note: reason,
      by,
      restoredFrom: n,
      ...(old.files !== undefined
        ? { files: Object.entries(old.files).map(([path, content]) => ({ path, content })) }
        : {}),
    },
    builtins,
  );
};

/**
 * One-tap undo: the version before the current one becomes current again,
 * but only within the current skill's own lineage. When the current version
 * created the skill (a removed skill's history may sit before it), there is
 * nothing to go back to: undefined, and the caller removes the skill.
 */
export const revertSkill = (
  root: string,
  owner: string,
  profile: string,
  name: string,
  builtins: readonly BuiltinSkill[],
  by: VersionAuthor = "owner",
): SkillMeta | undefined => {
  const history = skillVersions(root, owner, profile, name);
  const current = history.at(-1);
  const before = history.at(-2);
  if (current === undefined || before === undefined || current.created === true) return undefined;
  const born = history.findLastIndex((version) => version.created === true);
  if (born !== -1 && history.indexOf(before) < born) return undefined;
  return restoreSkillVersion(
    root,
    owner,
    profile,
    name,
    before.n,
    by,
    builtins,
    `Undid version ${current.n}`,
  );
};
