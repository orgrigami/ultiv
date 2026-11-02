/**
 * Learned-skill consolidation: a deterministic pass (no model) that finds
 * overlapping skills in one bot's library and parks ABSORB proposals in
 * the owner's inbox. Distinctive-word sets (name + description + body,
 * minus the shared memory stop words) score each pair; above
 * ABSORB_OVERLAP of the smaller set shared, the pair becomes a merge
 * candidate. The kept skill is the OLDER one (higher version count wins a
 * tie); each source's body rides in under `## Absorbed from <name>`,
 * skipped with a note when the merged body would exceed the size cap.
 * Built-ins are never sources (read-only) and never targets (they cannot
 * be modified). Accepting an absorb proposal applies through the batch
 * engine ATOMICALLY: the target is updated and every source removed, with
 * each source's version history retained by the version store.
 */
import type { SkillMeta, SkillOrigin, SkillProposal } from "@spriessen/contracts";
import { isStopWord } from "../memory/stopwords.ts";
import { applyOps } from "./batch.ts";
import { MAX_SKILL_CHARS } from "./guard.ts";
import { addProposal, listProposals } from "./proposals.ts";
import type { BuiltinSkill } from "./store.ts";
import { listSkills, readSkill } from "./store.ts";

/** Share of the smaller distinctive-word set that makes a pair a merge candidate. */
export const ABSORB_OVERLAP = 0.4;

/** One skill as the pass reads it (never a built-in). */
export interface CurateSkill {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly createdAt: number;
  readonly version: number;
  readonly origin: SkillOrigin;
}

export interface AbsorbCandidate {
  /** The skill that stays (the older of the pair). */
  readonly keep: CurateSkill;
  /** The skill(s) merged into it and removed on accept. */
  readonly sources: readonly CurateSkill[];
}

const wordSet = (text: string): Set<string> => {
  const found = new Set<string>();
  for (const word of text
    .normalize("NFKD")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (!isStopWord(word)) found.add(word);
  }
  return found;
};

const wordsOf = (skill: CurateSkill): Set<string> =>
  wordSet(`${skill.name}\n${skill.description}\n${skill.body}`);

/** Pairwise overlap; a candidate when the smaller set shares ABSORB_OVERLAP. */
const overlaps = (a: CurateSkill, b: CurateSkill): boolean => {
  const left = wordsOf(a);
  const right = wordsOf(b);
  const smaller = Math.min(left.size, right.size);
  if (smaller === 0) return false;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / smaller >= ABSORB_OVERLAP;
};

/** The older skill keeps; a dead heat goes to the higher version count. */
const keepOf = (a: CurateSkill, b: CurateSkill): readonly [CurateSkill, CurateSkill] =>
  a.createdAt !== b.createdAt
    ? a.createdAt < b.createdAt
      ? [a, b]
      : [b, a]
    : a.version >= b.version
      ? [a, b]
      : [b, a];

/**
 * Every overlapping pair, deterministically: a skill may appear in more
 * than one candidate; the owner sorts it out (one accept applies
 * atomically and stale plans refuse).
 */
export const absorbCandidates = (skills: readonly CurateSkill[]): readonly AbsorbCandidate[] => {
  const candidates: AbsorbCandidate[] = [];
  for (const [at, first] of skills.entries()) {
    if (first.origin === "builtin") continue;
    for (const second of skills.slice(at + 1)) {
      if (second.origin === "builtin") continue;
      if (!overlaps(first, second)) continue;
      const [keep, source] = keepOf(first, second);
      candidates.push({ keep, sources: [source] });
    }
  }
  return candidates;
};

export interface AbsorbDraft {
  readonly body: string;
  readonly note: string;
  readonly absorbed: { readonly name: string; readonly version: number }[];
}

/** The target's body plus one delimited section per source, size-capped. */
export const draftAbsorb = (keep: CurateSkill, sources: readonly CurateSkill[]): AbsorbDraft => {
  let body = keep.body;
  const absorbed: { name: string; version: number }[] = [];
  const skipped: string[] = [];
  for (const source of sources) {
    const section = `\n\n## Absorbed from ${source.name}\n\n${source.body}`;
    if (body.length + section.length > MAX_SKILL_CHARS) {
      skipped.push(source.name);
      continue;
    }
    body += section;
    absorbed.push({ name: source.name, version: source.version });
  }
  const note =
    absorbed.length === 0
      ? "nothing to absorb: the merged body would exceed the size cap"
      : `Absorbs ${absorbed.map((source) => source.name).join(", ")}` +
        (skipped.length > 0
          ? `; skipped ${skipped.join(", ")} (the merged body would exceed the size cap)`
          : "");
  return { body, note, absorbed };
};

const asCurateSkill = (
  root: string,
  owner: string,
  profile: string,
  meta: SkillMeta,
  builtins: readonly BuiltinSkill[],
): CurateSkill | undefined => {
  const found = readSkill(root, owner, profile, meta.name, builtins);
  if (found === undefined) return undefined;
  return {
    name: meta.name,
    description: meta.description,
    body: found.body,
    createdAt: meta.createdAt,
    version: meta.version,
    origin: meta.origin,
  };
};

/** Old rows have no kind; they read as their existing kind, an update. */
export const proposalKind = (proposal: SkillProposal): "update" | "absorb" =>
  proposal.kind ?? "update";

const openAbsorbOf = (proposals: readonly SkillProposal[]): readonly SkillProposal[] =>
  proposals.filter((proposal) => proposal.status === "open" && proposalKind(proposal) === "absorb");

const samePlan = (proposal: SkillProposal, keep: string, sources: readonly string[]): boolean =>
  proposal.skill === keep &&
  JSON.stringify((proposal.absorbed ?? []).map((source) => source.name).sort()) ===
    JSON.stringify([...sources].sort());

/**
 * Run the pass over one profile's non-builtin skills and park one absorb
 * proposal per overlapping pair (skipping plans already open with the same
 * keep + sources). Returns the proposals it parked this run.
 */
export const curateProfile = (
  root: string,
  owner: string,
  profile: string,
  builtins: readonly BuiltinSkill[],
): readonly SkillProposal[] => {
  const skills: CurateSkill[] = [];
  for (const meta of listSkills(root, owner, profile, builtins)) {
    if (meta.origin === "builtin") continue;
    const skill = asCurateSkill(root, owner, profile, meta, builtins);
    if (skill !== undefined) skills.push(skill);
  }
  const open = openAbsorbOf(listProposals(root, owner, profile));
  const parked: SkillProposal[] = [];
  for (const candidate of absorbCandidates(skills)) {
    const draft = draftAbsorb(candidate.keep, candidate.sources);
    const sources = draft.absorbed.map((source) => source.name);
    if (sources.length === 0) continue;
    if (open.some((proposal) => samePlan(proposal, candidate.keep.name, sources))) continue;
    parked.push(
      addProposal(root, owner, profile, {
        skill: candidate.keep.name,
        baseVersion: candidate.keep.version,
        body: draft.body,
        note: draft.note,
        byProfile: null,
        kind: "absorb",
        absorbed: draft.absorbed,
      }),
    );
  }
  return parked;
};

/**
 * Why an absorb proposal can no longer be applied as drafted, or undefined
 * when the store still matches the plan (target version and every source's
 * presence and version).
 */
export const staleAbsorbReason = (
  root: string,
  owner: string,
  profile: string,
  proposal: SkillProposal,
  builtins: readonly BuiltinSkill[],
): string | undefined => {
  const target = readSkill(root, owner, profile, proposal.skill, builtins);
  if (target === undefined) {
    return `the kept skill "${proposal.skill}" no longer exists, so nothing was applied; review the bot's skills and draft the consolidation again`;
  }
  if (target.meta.version !== proposal.baseVersion) {
    return `"${proposal.skill}" changed since this plan was drafted (now v${target.meta.version}, drafted against v${proposal.baseVersion}), so nothing was applied; review it and draft the consolidation again`;
  }
  for (const source of proposal.absorbed ?? []) {
    const found = readSkill(root, owner, profile, source.name, builtins);
    if (found === undefined) {
      return `the source skill "${source.name}" was removed since this plan was drafted, so nothing was applied; review the bot's skills and draft the consolidation again`;
    }
    if (found.meta.version !== source.version) {
      return `"${source.name}" changed since this plan was drafted (now v${found.meta.version}), so nothing was applied; review it and draft the consolidation again`;
    }
  }
  return undefined;
};

/**
 * The owner-accept path: update the kept skill to the drafted body and
 * remove every source, in ONE atomic batch; each source's version history
 * stays readable in the version store. The caller has checked staleness.
 */
export const applyAbsorb = async (
  root: string,
  owner: string,
  profile: string,
  proposal: SkillProposal,
  builtins: readonly BuiltinSkill[],
): Promise<SkillMeta> => {
  const sources = proposal.absorbed ?? [];
  await applyOps(
    root,
    owner,
    profile,
    [
      {
        op: "update",
        name: proposal.skill,
        body: proposal.body,
        absorbed: sources.map((source) => source.name),
      },
      ...sources.map((source) => ({ op: "remove" as const, name: source.name })),
    ],
    { builtins, by: "owner", note: `absorbed ${sources.map((source) => source.name).join(", ")}` },
  );
  const target = readSkill(root, owner, profile, proposal.skill, builtins);
  if (target === undefined) throw new Error(`absorb lost its target "${proposal.skill}"`);
  return target.meta;
};
