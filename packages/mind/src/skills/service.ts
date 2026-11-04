/**
 * The skills service: the store behind the bot's skill tools and the REST
 * surface the owner's Skills page reads. One instance per mind; built-ins
 * (the app's own skill folders) are parsed once and merged into every
 * profile's listing. All paths resolve under the root; every mutation keeps
 * the index file authoritative so listings never scan folders.
 */
import type { SkillDetail, SkillMeta, SkillOrigin, SkillProposal } from "@spriessen/contracts";
import { aboutSkills } from "@spriessen/about";
import { parseSkillDoc } from "./frontmatter.ts";
import {
  type BuiltinSkill,
  type SkillFileIn,
  listSkills,
  readSkill,
  readSkillFile,
  removeSkill,
  setSkillEnabled,
  skillsDir,
  writeSkill,
} from "./store.ts";
import { restoreSkillVersion, revertSkill, skillVersions } from "./store-versions.ts";
import { addProposal, decideProposal, listProposals } from "./proposals.ts";
import { applyOps as applySkillOps, type SkillOp, type SkillOpOutcome } from "./batch.ts";
import { applyAbsorb, curateProfile, proposalKind, staleAbsorbReason } from "./curate.ts";
import { MAX_SKILL_CHARS, secretIn } from "./guard.ts";
import type { Version, VersionAuthor } from "../versions/store.ts";

/** A skill update parked for the owner (skill_propose / the evolution loop). */
export interface SkillProposeInput {
  readonly skill: string;
  readonly body: string;
  readonly note: string;
  readonly byProfile: string | null;
}

export interface SkillWriteInput {
  readonly name: string;
  readonly body: string;
  /** Defaults: keep the stored origin, else "self" from a bot, "owner" via REST. */
  readonly origin?: SkillOrigin;
  readonly sourceUrl?: string | null;
  readonly authorProfile?: string | null;
  readonly parentVersion?: number | null;
  readonly note?: string | null;
  /** Who saved it, for the history; defaults to owner for owner edits, else bot. */
  readonly by?: VersionAuthor;
  /** The turn a bot's write came from (conversation and call). */
  readonly turn?: string;
  /** The skill's complete reference set; omitted leaves current files untouched. */
  readonly files?: readonly SkillFileIn[];
}

export interface SkillBatchInput {
  /** Who saves, for the history; defaults by origin (owner, else bot). */
  readonly by?: VersionAuthor;
  /** The turn a bot's batch came from (conversation and call). */
  readonly turn?: string;
  /** Per-op content gate; a refusal at any op aborts the whole batch. */
  readonly gate?: (
    input: {
      readonly name: string;
      readonly body: string;
      readonly files?: readonly { readonly path: string; readonly content: string }[];
    },
    index: number,
  ) => Promise<string | undefined>;
}

export interface SkillsService {
  readonly root: string;
  readonly builtins: readonly BuiltinSkill[];
  readonly list: (owner: string, profile: string) => Promise<readonly SkillMeta[]>;
  readonly read: (owner: string, profile: string, name: string) => Promise<SkillDetail | undefined>;
  readonly readFile: (
    owner: string,
    profile: string,
    name: string,
    rel: string,
  ) => Promise<string | undefined>;
  readonly write: (owner: string, profile: string, input: SkillWriteInput) => Promise<SkillMeta>;
  /**
   * Several ops in one all-or-nothing batch: every op is validated before
   * anything is written, and a failure anywhere rolls every affected skill
   * back to its pre-batch state. `remove` is valid here (the consolidation
   * accept path); the bot-facing tool refuses it.
   */
  readonly applyOps: (
    owner: string,
    profile: string,
    ops: readonly SkillOp[],
    options?: SkillBatchInput,
  ) => Promise<SkillOpOutcome[]>;
  readonly remove: (owner: string, profile: string, name: string) => Promise<boolean>;
  readonly setEnabled: (
    owner: string,
    profile: string,
    name: string,
    enabled: boolean,
  ) => Promise<SkillMeta | undefined>;
  /** Undo: the version before the current one becomes current again, as a new version. */
  readonly revert: (owner: string, profile: string, name: string) => Promise<SkillMeta | undefined>;
  /** The skill's history, oldest first ([] for built-ins and unknown names). */
  readonly versions: (owner: string, profile: string, name: string) => Promise<readonly Version[]>;
  /** Make version `n` current again, as a new version. */
  readonly restore: (
    owner: string,
    profile: string,
    name: string,
    n: number,
  ) => Promise<SkillMeta | undefined>;
  readonly propose: (
    owner: string,
    profile: string,
    input: SkillProposeInput,
  ) => Promise<SkillProposal>;
  readonly proposalsOf: (owner: string, profile: string) => Promise<readonly SkillProposal[]>;
  /** Set a proposal's verdict; "accepted" applies the proposed body as a new version. */
  readonly decide: (
    owner: string,
    profile: string,
    id: string,
    verdict: "accepted" | "rejected",
  ) => Promise<SkillProposal | undefined>;
  /**
   * Run the deterministic consolidation pass over one bot's learned
   * skills and park an absorb proposal per overlapping pair; returns the
   * proposals parked this run.
   */
  readonly curate: (owner: string, profile: string) => Promise<readonly SkillProposal[]>;
}

/** Built-in skills from the app package: parse once, fail loudly on drift. */
const builtinSkills = (): readonly BuiltinSkill[] =>
  aboutSkills().map((skill) => {
    const doc = parseSkillDoc(skill.markdown);
    if (doc === undefined) {
      throw new Error(`built-in skill "${skill.name}" has no valid frontmatter`);
    }
    return {
      name: doc.name,
      description: doc.description,
      markdown: skill.markdown,
      files: skill.files,
    };
  });

export const skillsService = (options: { root?: string } = {}): SkillsService => {
  const root = options.root ?? skillsDir();
  const builtins = builtinSkills();
  return {
    root,
    builtins,
    list: async (owner, profile) => listSkills(root, owner, profile, builtins),
    read: async (owner, profile, name) => {
      const found = readSkill(root, owner, profile, name, builtins);
      if (found === undefined) return undefined;
      return {
        ...found,
        proposals: listProposals(root, owner, profile).filter(
          (proposal) => proposal.skill === name,
        ),
      };
    },
    readFile: async (owner, profile, name, rel) =>
      readSkillFile(root, owner, profile, name, rel, builtins),
    write: async (owner, profile, input) =>
      writeSkill(
        root,
        owner,
        profile,
        {
          name: input.name,
          body: input.body,
          origin: input.origin ?? "self",
          ...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
          ...(input.authorProfile !== undefined ? { authorProfile: input.authorProfile } : {}),
          ...(input.parentVersion !== undefined ? { parentVersion: input.parentVersion } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
          ...(input.files !== undefined ? { files: input.files } : {}),
          ...(input.by !== undefined ? { by: input.by } : {}),
          ...(input.turn !== undefined ? { turn: input.turn } : {}),
        },
        builtins,
      ),
    remove: async (owner, profile, name) => removeSkill(root, owner, profile, name, builtins),
    applyOps: async (owner, profile, ops, options = {}) =>
      applySkillOps(root, owner, profile, ops, {
        builtins,
        ...(options.by !== undefined ? { by: options.by } : {}),
        ...(options.turn !== undefined ? { turn: options.turn } : {}),
        ...(options.gate !== undefined ? { gate: options.gate } : {}),
      }),
    setEnabled: async (owner, profile, name, enabled) =>
      setSkillEnabled(root, owner, profile, name, enabled, builtins),
    revert: async (owner, profile, name) => revertSkill(root, owner, profile, name, builtins),
    versions: async (owner, profile, name) => skillVersions(root, owner, profile, name),
    restore: async (owner, profile, name, n) =>
      restoreSkillVersion(root, owner, profile, name, n, "owner", builtins),
    propose: async (owner, profile, input) => {
      if (input.body.length > MAX_SKILL_CHARS) {
        throw new Error(`proposal exceeds ${MAX_SKILL_CHARS} chars`);
      }
      if (secretIn(input.body) !== null) {
        throw new Error("refused: the body looks like it contains a secret");
      }
      if (parseSkillDoc(input.body) === undefined) {
        throw new Error("a proposal body needs valid frontmatter (name and description)");
      }
      const base = readSkill(root, owner, profile, input.skill, builtins);
      return addProposal(root, owner, profile, {
        skill: input.skill,
        baseVersion: base?.meta.version ?? 0,
        body: input.body,
        note: input.note,
        byProfile: input.byProfile,
      });
    },
    proposalsOf: async (owner, profile) => listProposals(root, owner, profile),
    curate: async (owner, profile) => curateProfile(root, owner, profile, builtins),
    decide: async (owner, profile, id, verdict) => {
      // An absorb accept refuses cleanly when the store drifted since the
      // plan was drafted: stale proposals never half-apply.
      const pending = listProposals(root, owner, profile).find((entry) => entry.id === id);
      if (
        verdict === "accepted" &&
        pending !== undefined &&
        pending.status === "open" &&
        proposalKind(pending) === "absorb"
      ) {
        const stale = staleAbsorbReason(root, owner, profile, pending, builtins);
        if (stale !== undefined) throw new Error(stale);
      }
      const decided = decideProposal(root, owner, profile, id, verdict);
      if (decided === undefined || verdict === "rejected") return decided;
      if (proposalKind(decided) === "absorb") {
        await applyAbsorb(root, owner, profile, decided, builtins);
        return decided;
      }
      writeSkill(
        root,
        owner,
        profile,
        {
          name: decided.skill,
          body: decided.body,
          origin: "self",
          authorProfile: decided.byProfile,
          parentVersion: decided.baseVersion,
          note: decided.note,
          by: "owner",
        },
        builtins,
      );
      return decided;
    },
  };
};
