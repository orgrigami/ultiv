/**
 * Deciding a tidy proposal: the ONLY place a proposal changes facts. One
 * commit holds the proposal's status and every fact it touches, so a failure
 * leaves both as they were. A decided proposal is never applied again, and
 * each fact must still be in the state the proposal saw: a fact the owner
 * forgot, archived or replaced since is left alone (reported as skipped) —
 * accepting an old archive suggestion never pulls a forgotten fact back out
 * of Purge's reach.
 */
import { Effect } from "effect";
import type { MemoryFact, MemoryProposal } from "@spriessen/contracts";
import type { ConverseService } from "../converse/converse.ts";
import { FactsDoc, ProposalsDoc } from "./model.ts";

export type ProposalOutcome =
  | { readonly kind: "unknown" }
  /** The accept can't apply as asked (a conflict without a valid `keep`). */
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "decided"; readonly status: MemoryProposal["status"] }
  | {
      readonly kind: "done";
      readonly status: "accepted" | "rejected";
      /** Facts the proposal named that had moved on and were left alone. */
      readonly skipped: readonly string[];
    };

type Applied = { readonly facts: MemoryFact[]; readonly skipped: string[] };

const isCurrent = (fact: MemoryFact | undefined): fact is MemoryFact =>
  fact !== undefined && fact.status === "current";

/** Why a conflict accept can't apply, or null when `keep` names one side. */
export const keepProblem = (
  proposal: Pick<MemoryProposal, "kind" | "factIds">,
  keep: string | undefined,
): string | null => {
  if (proposal.kind !== "conflict") return null;
  if (keep === undefined) return "choose which fact to keep (keep: <fact id>)";
  return proposal.factIds.slice(0, 2).includes(keep)
    ? null
    : "keep must be one of the two facts in this conflict";
};

/**
 * What accepting `proposal` does to `facts`, pure. A conflict needs `keep`:
 * the side the owner chose (see `keepProblem`).
 */
export const applyProposal = (
  proposal: Pick<MemoryProposal, "kind" | "factIds">,
  facts: readonly MemoryFact[],
  now: number,
  keep?: string,
): Applied => {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const changes = new Map<string, MemoryFact>();
  const skipped: string[] = [];
  const ids = proposal.factIds;
  if (proposal.kind === "archive" || proposal.kind === "stale") {
    for (const id of ids) {
      const fact = byId.get(id);
      if (isCurrent(fact)) changes.set(id, { ...fact, status: "archived", expiredAt: now });
      else skipped.push(id);
    }
  } else if (proposal.kind === "secret") {
    // A secret is forgotten whatever state it is in: its text must reach Purge.
    for (const id of ids) {
      const fact = byId.get(id);
      if (fact !== undefined && fact.status !== "forgotten") {
        changes.set(id, { ...fact, status: "forgotten", expiredAt: now });
      } else skipped.push(id);
    }
  } else if (proposal.kind === "merge") {
    // The first id survives; the rest become its history.
    const [primary, ...others] = ids;
    if (!isCurrent(byId.get(primary ?? ""))) skipped.push(...ids);
    else {
      for (const id of others) {
        const fact = byId.get(id);
        if (isCurrent(fact)) {
          changes.set(id, {
            ...fact,
            status: "superseded",
            supersededBy: primary ?? null,
            expiredAt: now,
          });
        } else skipped.push(id);
      }
    }
  } else if (proposal.kind === "conflict") {
    // [older, newer]: the owner chose which one holds. Keeping the newer
    // retires the older as CHANGED (true once, kept as the past); keeping
    // the older says the newer claim was WRONG (corrected, never offered).
    const [olderId, newerId] = ids;
    const older = byId.get(olderId ?? "");
    const newer = byId.get(newerId ?? "");
    if (!isCurrent(older) || !isCurrent(newer)) skipped.push(...ids);
    else if (keep === newer.id) changes.set(older.id, retire(older, newer, now, "changed"));
    else if (keep === older.id) changes.set(newer.id, retire(newer, older, now, "corrected"));
  }
  // core-fix, entity-merge, backfill, share: record-only accepts.
  return {
    facts: facts.map((fact) => changes.get(fact.id) ?? fact),
    skipped,
  };
};

/** The losing side of a conflict, linked to the fact that holds. */
const retire = (
  loser: MemoryFact,
  winner: MemoryFact,
  now: number,
  why: "changed" | "corrected",
): MemoryFact => ({
  ...loser,
  status: "superseded",
  retired: why,
  supersededBy: winner.id,
  // A changed fact held until the newer one began; a wrong one never held.
  ...(why === "changed" ? { validTo: winner.validFrom ?? now } : {}),
  expiredAt: now,
});

/** Accept or reject one proposal of the store at `key`, in one commit. */
export const decideProposal = (
  converse: ConverseService,
  key: string,
  proposalId: string,
  verdict: "accept" | "reject",
  keep?: string,
): Promise<ProposalOutcome> =>
  Effect.runPromise(
    converse.docs.commit<ProposalOutcome>(async (tx) => {
      const proposals = await tx.doc(ProposalsDoc, key, { proposals: [] });
      const proposal = proposals.proposals.find((entry) => entry.id === proposalId);
      if (proposal === undefined) return { kind: "unknown" };
      if (proposal.status !== "open") return { kind: "decided", status: proposal.status };
      const now = Date.now();
      let skipped: string[] = [];
      if (verdict === "accept") {
        const problem = keepProblem(proposal, keep);
        if (problem !== null) return { kind: "invalid", reason: problem };
        const store = await tx.doc(FactsDoc, key, { facts: [], migratedAt: null });
        const applied = applyProposal(
          { kind: proposal.kind, factIds: [...proposal.factIds] },
          store.facts,
          now,
          keep,
        );
        store.facts = applied.facts;
        skipped = applied.skipped;
      }
      const status = verdict === "accept" ? "accepted" : "rejected";
      proposals.proposals = proposals.proposals.map((entry) =>
        entry.id === proposalId ? { ...entry, status, decidedAt: now } : entry,
      );
      // Plain values only: draft values die with the transaction.
      return { kind: "done", status, skipped: [...skipped] };
    }),
  ) as Promise<ProposalOutcome>;
