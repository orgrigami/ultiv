/**
 * The consolidating write: extraction (a model call, needs no lock) then ONE
 * `docs.commit` transaction that re-reads the store, DECIDES, and applies
 * under the lock — a concurrent write can no longer slip between the
 * decision and the apply. Decision rules live in decide.ts; extraction in
 * extract.ts. Nothing is deleted: supersede and refine create new versions
 * and mark the old ones superseded.
 */
import { randomUUID } from "node:crypto";
import type { FactKind, FactTrust, MemoryFact } from "@spreissen/contracts";
import type { Tx } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { InvalidInput } from "@spreissen/core";
import type { ConverseService } from "../converse/converse.ts";
import type { DecideService } from "../decide/decide.ts";
import type { GenerateService } from "../generate/generate.ts";
import { decideWrite, type WriteOp } from "./decide.ts";
import { extractFact } from "./extract.ts";
import { resolveEntitiesInTx } from "./graph.ts";
import {
  EpisodesDoc,
  FactsDoc,
  GraphDoc,
  LIMITS,
  ProposalsDoc,
  factHash,
  newFact,
  ownerKey,
  profileKey,
} from "./model.ts";
import { normalize } from "./text.ts";

export interface WriteFactInput {
  readonly owner: string;
  readonly profileId: string | null;
  readonly scope: "profile" | "owner";
  readonly writer: string | null;
  readonly text: string;
  readonly tags?: readonly string[];
  readonly kind?: FactKind;
  readonly importance?: number;
  readonly basis?: "owner_said" | "observed" | "inferred";
  readonly replaces?: string | null;
  readonly validFrom?: number | null;
  readonly trust?: FactTrust;
  readonly origin?: string;
  readonly conversation?: string | null;
}

export interface WriteFactResult {
  readonly id: string;
  readonly op: WriteOp;
  readonly replaced: string | null;
  readonly entities: readonly string[];
}

const BASIS_CONFIDENCE = { owner_said: 0.9, observed: 0.7, inferred: 0.5 } as const;

/** A merge proposal for an ambiguous add — the tidy surfaces it to Harry. */
const mergeProposal = (factIds: readonly string[], summary: string) => ({
  id: randomUUID(),
  kind: "merge" as const,
  at: Date.now(),
  factIds: [...factIds],
  summary,
  fingerprint: factHash(factIds.join("|")),
  status: "open" as const,
  decidedAt: null,
});

/** The apply half of the write, running INSIDE the transaction. */
const applyDecision = async (
  tx: Tx,
  plan: {
    readonly key: string;
    readonly input: WriteFactInput;
    readonly extracted: {
      readonly text: string;
      readonly kind: FactKind;
      readonly confidence: number;
      readonly entityNames: readonly string[];
      readonly triple: MemoryFact["triple"];
    };
    readonly decision: Awaited<ReturnType<typeof decideWrite>>;
    readonly current: readonly MemoryFact[];
  },
): Promise<{ id: string; op: WriteOp; replaced: string | null; entities: string[] }> => {
  const { key, input, extracted, decision, current } = plan;
  const now = Date.now();
  const facts = await tx.doc(FactsDoc, key, { facts: [], migratedAt: null });
  if (decision.op === "noop") {
    const target = facts.facts.find((fact) => fact.id === decision.targetId);
    if (target === undefined) {
      return { id: decision.targetId ?? "", op: "noop", replaced: null, entities: [] };
    }
    const mergedTags = [...new Set([...target.tags, ...(input.tags ?? [])])].slice(0, LIMITS.tags);
    const updated: MemoryFact = {
      ...target,
      confirmedAt: now,
      tags: mergedTags,
      importance: Math.max(target.importance, input.importance ?? target.importance),
    };
    facts.facts = facts.facts.map((fact) => (fact.id === target.id ? updated : fact));
    return { id: target.id, op: "noop", replaced: null, entities: target.entities };
  }
  const text = decision.op === "refine" ? (decision.mergedText ?? extracted.text) : extracted.text;
  // Entity resolution/creation rides the same transaction: known names
  // fold to their id, unknown names become entities (deterministic).
  const graphDoc = await tx.doc(GraphDoc, key, { entities: [] });
  const entityIds = resolveEntitiesInTx(graphDoc, extracted.entityNames, null);
  const kind = input.kind ?? extracted.kind;
  const confidence =
    input.basis !== undefined ? BASIS_CONFIDENCE[input.basis] : extracted.confidence;
  const fact = newFact({
    id: randomUUID(),
    scope: input.scope,
    profile: input.profileId,
    text,
    kind,
    tags: input.tags ?? [],
    entities: entityIds,
    triple: extracted.triple,
    importance: input.importance ?? 3,
    confidence,
    trust:
      input.trust ?? (input.scope === "owner" ? "owner" : input.writer === null ? "owner" : "self"),
    source: {
      via: input.writer === null ? "rest" : "tool",
      writer: input.writer,
      origin: input.origin ?? "owner",
      conversation: input.conversation ?? null,
      episode: null,
    },
    validFrom: input.validFrom ?? now,
    supersedes: decision.targetId === null ? [] : [decision.targetId],
    at: now,
  });
  if (decision.targetId !== null) {
    // Supersede/refine: the old version stays as history, linked forward.
    facts.facts = facts.facts.map((existing) =>
      existing.id === decision.targetId
        ? {
            ...existing,
            status: "superseded" as const,
            supersededBy: fact.id,
            validTo: now,
            expiredAt: now,
          }
        : existing,
    );
  } else if (decision.via === "fallback") {
    // Ambiguous add: queue a merge proposal for the weekly tidy.
    const match = current.find((candidate) => factHash(candidate.text) !== factHash(text));
    if (match !== undefined) {
      const proposals = await tx.doc(ProposalsDoc, key, { proposals: [] });
      proposals.proposals = [
        mergeProposal(
          [match.id, fact.id],
          `A new fact may duplicate an existing one: "${text.slice(0, 120)}" vs "${match.text.slice(0, 120)}"`,
        ),
        ...proposals.proposals,
      ];
    }
  }
  facts.facts = [...facts.facts, fact];
  await recordEpisode(tx, key, input, fact.id, now);
  return { id: fact.id, op: decision.op, replaced: decision.targetId, entities: entityIds };
};

/** Provenance: one episode per write (ring of 1,000 full inputs). */
const recordEpisode = async (
  tx: Tx,
  key: string,
  input: WriteFactInput,
  factId: string,
  now: number,
): Promise<void> => {
  if (input.text === "") return;
  const episodes = await tx.doc(EpisodesDoc, key, { episodes: [] });
  const kept = [
    {
      id: randomUUID(),
      at: now,
      origin: input.origin ?? "owner",
      conversation: input.conversation ?? null,
      input: input.text.slice(0, 2_000),
      facts: [factId],
    },
    ...episodes.episodes,
  ].slice(0, LIMITS.episodesRing * 2);
  episodes.episodes = kept.map((episode, index) =>
    index >= LIMITS.episodesRing ? { ...episode, input: "" } : episode,
  );
};

export const writeFactV2 = async (
  deps: {
    readonly converse: ConverseService;
    readonly generate?: GenerateService;
    readonly decide?: DecideService;
  },
  input: WriteFactInput,
): Promise<WriteFactResult> => {
  const key =
    input.profileId === null ? ownerKey(input.owner) : profileKey(input.owner, input.profileId);
  // Extraction needs the graph only for the known-name list; no lock held.
  const graph = await Effect.runPromise(deps.converse.docs.snapshotKeyed(GraphDoc, key)).then(
    (store) => store?.entities ?? [],
    () => [],
  );
  const knownNames = [
    ...new Set(
      graph.flatMap((entity) =>
        entity.mergedInto === null ? [entity.name, ...entity.aliases] : [],
      ),
    ),
  ].slice(0, 30);
  const extracted = await extractFact(deps, input.text, knownNames);
  // Decision + retention INSIDE the transaction, over facts re-read under
  // the lock (the old code decided on a snapshot taken before it).
  return Effect.runPromise(
    deps.converse.docs.commit<{
      id: string;
      op: WriteOp;
      replaced: string | null;
      entities: string[];
    }>(async (tx) => {
      const facts = await tx.doc(FactsDoc, key, { facts: [], migratedAt: null });
      const graphDoc = await tx.doc(GraphDoc, key, { entities: [] });
      const current = facts.facts.filter((fact) => fact.status === "current");
      // Retention: the hard cap refuses only LOW-importance bot writes; the
      // owner (human) and importance ≥3 writes still land, so review never
      // loses.
      if (
        current.length >= LIMITS.hardFacts &&
        input.writer !== null &&
        (input.importance ?? 3) <= 2
      ) {
        throw new InvalidInput({
          reason: "memory is full; ask Harry to review the tidy list",
        });
      }
      const decision = await decideWrite(deps, {
        text: extracted.text,
        tags: input.tags ?? [],
        entityIds: graphDoc.entities
          .filter((entity) => entity.mergedInto === null)
          .filter((entity) =>
            extracted.entityNames.some(
              (name) =>
                normalize(entity.name) === normalize(name) ||
                entity.aliases.some((alias) => normalize(alias) === normalize(name)),
            ),
          )
          .map((entity) => entity.id),
        triple: extracted.triple,
        ...(input.replaces !== undefined ? { replaces: input.replaces } : {}),
        current,
      });
      return applyDecision(tx, {
        key,
        input,
        extracted,
        decision,
        current,
      });
    }),
  );
};

export type { WriteOp };
