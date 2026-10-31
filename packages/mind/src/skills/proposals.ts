/**
 * Skill proposals: changes parked for the owner's decision, the memory
 * tidy's pattern one tier up. An evolution run (or a bot's own rewrite) that
 * should not take effect directly lands here instead; the owner accepts or
 * rejects it from the Skills page. Stored beside the profile's skill index
 * as one JSON file; bodies are validated by the caller (the same rules as
 * skill_write).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SkillProposal } from "@spreissen/contracts";

const PROPOSALS_MAX = 50;

const fileOf = (root: string, owner: string, profile: string): string =>
  join(root, owner, profile, "skills.proposals.json");

const readAll = (root: string, owner: string, profile: string): SkillProposal[] => {
  const file = fileOf(root, owner, profile);
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { proposals?: SkillProposal[] };
    return raw.proposals ?? [];
  } catch {
    return [];
  }
};

const writeAll = (
  root: string,
  owner: string,
  profile: string,
  proposals: readonly SkillProposal[],
): void => {
  writeFileSync(fileOf(root, owner, profile), JSON.stringify({ proposals }, null, "\t"));
};

export interface SkillPropose {
  readonly skill: string;
  readonly baseVersion: number;
  readonly body: string;
  readonly note: string;
  /** The proposing profile; null for owner drafts. */
  readonly byProfile: string | null;
}

/** Park one proposal (oldest evicted beyond the cap). */
export const addProposal = (
  root: string,
  owner: string,
  profile: string,
  input: SkillPropose,
): SkillProposal => {
  const proposal: SkillProposal = {
    id: randomUUID(),
    skill: input.skill,
    at: Date.now(),
    byProfile: input.byProfile,
    baseVersion: input.baseVersion,
    body: input.body,
    note: input.note.slice(0, 300),
    status: "open",
    decidedAt: null,
  };
  const all = readAll(root, owner, profile);
  all.unshift(proposal);
  writeAll(root, owner, profile, all.slice(0, PROPOSALS_MAX));
  return proposal;
};

export const listProposals = (root: string, owner: string, profile: string): SkillProposal[] =>
  readAll(root, owner, profile);

/** Set a proposal's verdict; returns it, or undefined when unknown. */
export const decideProposal = (
  root: string,
  owner: string,
  profile: string,
  id: string,
  verdict: "accepted" | "rejected",
): SkillProposal | undefined => {
  const all = readAll(root, owner, profile);
  const proposal = all.find((entry) => entry.id === id);
  if (proposal === undefined || proposal.status !== "open") return undefined;
  proposal.status = verdict;
  proposal.decidedAt = Date.now();
  writeAll(root, owner, profile, all);
  return proposal;
};
