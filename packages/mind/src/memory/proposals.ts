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

/** What accepting `proposal` does to `facts`, pure. */
export const applyProposal = (
  proposal: Pick<MemoryProposal, "kind" | "factIds">,
  facts: readonly MemoryFact[],
  now: number,
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
    // [older, newer]: the newer one holds; the older one is kept as the past.
    const [olderId, newerId] = ids;
    const older = byId.get(olderId ?? "");
    const newer = byId.get(newerId ?? "");
    if (!isCurrent(older) || !isCurrent(newer)) skipped.push(...ids);
    else changes.set(older.id, retire(older, newer, now));
  }
  // core-fix, entity-merge, backfill, share: record-only accepts.
  return {
    facts: facts.map((fact) => changes.get(fact.id) ?? fact),
    skipped,
  };
};

/** The losing side of a conflict: retired as changed, linked forward. */
const retire = (loser: MemoryFact, winner: MemoryFact, now: number): MemoryFact => ({
  ...loser,
  status: "superseded",
  retired: "changed",
  supersededBy: winner.id,
  validTo: winner.validFrom ?? now,
  expiredAt: now,
});

/** Accept or reject one proposal of the store at `key`, in one commit. */
export const decideProposal = (
  converse: ConverseService,
  key: string,
  proposalId: string,
  verdict: "accept" | "reject",
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
        const store = await tx.doc(FactsDoc, key, { facts: [], migratedAt: null });
        const applied = applyProposal(
          { kind: proposal.kind, factIds: [...proposal.factIds] },
          store.facts,
          now,
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
