/**
 * Shared team memory (slice 9): a team bot proposes one of its
 * OWN profile facts for the team's shared store; a team admin
 * accepts or rejects — the existing proposal flow, addressed at the
 * team store. Nothing is shared until accepted; rejection discards;
 * org bots never touch this (their flow is today's per-bot one).
 */
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { MemoryFact, MemoryProposal } from "@spriessen/contracts";
import type { ConverseService } from "../converse/converse.ts";
import { FactsDoc, ProposalsDoc, teamKey, profileKey } from "./model.ts";
import { newFact } from "./model.ts";

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

/** The fingerprint encodes the source (owner, profile, fact) for the copy. */
const fingerprintOf = (owner: string, profileId: string, factId: string): string =>
  `share:${owner}:${profileId}:${factId}`;

const parseFingerprint = (
  fingerprint: string,
): { owner: string; profileId: string; factId: string } | null => {
  const parts = fingerprint.split(":");
  if (parts.length !== 4 || parts[0] !== "share") return null;
  return { owner: parts[1] ?? "", profileId: parts[2] ?? "", factId: parts[3] ?? "" };
};

const readProposals = async (converse: ConverseService, key: string): Promise<MemoryProposal[]> =>
  run(converse.docs.snapshotKeyed(ProposalsDoc, key)).then((store) => store?.proposals ?? []);

export interface ShareOps {
  readonly proposeShare: (input: {
    readonly owner: string;
    readonly profileId: string;
    readonly teamId: string;
    readonly factId: string;
    readonly summary: string;
  }) => Promise<MemoryProposal>;
  readonly teamFacts: (owner: string, teamId: string) => Promise<readonly MemoryFact[]>;
  readonly decideShare: (input: {
    readonly owner: string;
    readonly teamId: string;
    readonly proposalId: string;
    readonly accept: boolean;
  }) => Promise<"accepted" | "rejected" | "unknown">;
}

export const shareOps = (converse: ConverseService): ShareOps => ({
  proposeShare: async (input) => {
    const key = teamKey(input.owner, input.teamId);
    const fingerprint = fingerprintOf(input.owner, input.profileId, input.factId);
    const existing = (await readProposals(converse, key)).find(
      (proposal) => proposal.fingerprint === fingerprint && proposal.status === "open",
    );
    if (existing !== undefined) return existing;
    // The fact must exist in the proposer's own store: sharing proposes
    // something the bot actually remembers, never an invention.
    const own = await run(
      converse.docs.snapshotKeyed(FactsDoc, profileKey(input.owner, input.profileId)),
    );
    const fact = own?.facts.find((row) => row.id === input.factId && row.status === "current");
    if (fact === undefined) {
      throw new Error("refused: share a fact you actually remember (by id from the write)");
    }
    const proposal: MemoryProposal = {
      id: randomUUID(),
      kind: "share",
      at: Date.now(),
      factIds: [input.factId],
      summary: input.summary.slice(0, 500),
      fingerprint,
      status: "open",
      decidedAt: null,
    };
    await run(
      converse.docs.commit(async (tx) => {
        const draft = await tx.doc(ProposalsDoc, key, { proposals: [] });
        draft.proposals = [proposal, ...draft.proposals];
      }),
    );
    return proposal;
  },
  teamFacts: async (owner, teamId) =>
    run(converse.docs.snapshotKeyed(FactsDoc, teamKey(owner, teamId))).then(
      (store) => store?.facts ?? [],
    ),
  decideShare: async (input) => {
    const key = teamKey(input.owner, input.teamId);
    const proposals = await readProposals(converse, key);
    const proposal = proposals.find(
      (row) => row.id === input.proposalId && row.status === "open" && row.kind === "share",
    );
    if (proposal === undefined) return "unknown";
    if (input.accept) {
      const source = parseFingerprint(proposal.fingerprint);
      if (source !== null) {
        const own = await run(
          converse.docs.snapshotKeyed(FactsDoc, profileKey(source.owner, source.profileId)),
        );
        const fact = own?.facts.find((row) => row.id === source.factId);
        if (fact !== undefined) {
          const shared = newFact({
            ...fact,
            at: fact.createdAt,
            scope: "team",
            profile: null,
          });
          await run(
            converse.docs.commit(async (tx) => {
              const draft = await tx.doc(FactsDoc, key, { facts: [], migratedAt: null });
              // Idempotent: accepting twice must not duplicate the fact.
              draft.facts = [shared, ...draft.facts.filter((row) => row.id !== shared.id)];
            }),
          );
        }
      }
    }
    await run(
      converse.docs.commit(async (tx) => {
        const draft = await tx.doc(ProposalsDoc, key, { proposals: [] });
        draft.proposals = draft.proposals.map((row) =>
          row.id === proposal.id
            ? { ...row, status: input.accept ? "accepted" : "rejected", decidedAt: Date.now() }
            : row,
        );
      }),
    );
    return input.accept ? "accepted" : "rejected";
  },
});
