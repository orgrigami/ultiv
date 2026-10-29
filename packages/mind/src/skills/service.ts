/**
 * The skills service: the store behind the bot's skill tools and the REST
 * surface the owner's Skills page reads. One instance per mind; built-ins
 * (the app's own skill folders) are parsed once and merged into every
 * profile's listing. All paths resolve under the root; every mutation keeps
 * the index file authoritative so listings never scan folders.
 */
import type { SkillDetail, SkillMeta, SkillOrigin, SkillProposal } from "@ultiv/contracts";
import { aboutSkills } from "@ultiv/about";
import { parseSkillDoc } from "./frontmatter.ts";
import {
  type BuiltinSkill,
  listSkills,
  readSkill,
  readSkillFile,
  removeSkill,
  revertSkill,
  setSkillEnabled,
  skillsDir,
  writeSkill,
} from "./store.ts";
import { addProposal, decideProposal, listProposals } from "./proposals.ts";
import { MAX_SKILL_CHARS, secretIn } from "./guard.ts";

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
  readonly remove: (owner: string, profile: string, name: string) => Promise<boolean>;
  readonly setEnabled: (
    owner: string,
    profile: string,
    name: string,
    enabled: boolean,
  ) => Promise<SkillMeta | undefined>;
  readonly revert: (owner: string, profile: string, name: string) => Promise<SkillMeta | undefined>;
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
    readFile: async (owner, profile, name, rel) => readSkillFile(root, owner, profile, name, rel),
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
        },
        builtins,
      ),
    remove: async (owner, profile, name) => removeSkill(root, owner, profile, name, builtins),
    setEnabled: async (owner, profile, name, enabled) =>
      setSkillEnabled(root, owner, profile, name, enabled, builtins),
    revert: async (owner, profile, name) => revertSkill(root, owner, profile, name, builtins),
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
    decide: async (owner, profile, id, verdict) => {
      const decided = decideProposal(root, owner, profile, id, verdict);
      if (decided === undefined || verdict === "rejected") return decided;
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
        },
        builtins,
      );
      return decided;
    },
  };
};
