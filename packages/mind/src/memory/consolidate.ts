/**
 * The consolidating write: extraction (a model call, needs no lock) then ONE
 * `docs.commit` transaction that re-reads the store, DECIDES, and applies
 * under the lock — a concurrent write can no longer slip between the
 * decision and the apply. Decision rules live in decide.ts; extraction in
 * extract.ts. Nothing is deleted: supersede and refine create new versions
 * and mark the old ones superseded.
 */
import { randomUUID } from "node:crypto";
import type { FactKind, FactTrust, MemoryEntity, MemoryFact } from "@spriessen/contracts";
import type { Tx } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { InvalidInput } from "@spriessen/core";
import type { ConverseService } from "../converse/converse.ts";
import type { DecideService } from "../decide/decide.ts";
import type { GenerateService } from "../generate/generate.ts";
import { decideWrite, type WriteOp } from "./decide.ts";
import { extractFact } from "./extract.ts";
import { requireFactRef } from "./handles.ts";
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
  /** World-time end known at write time ("until the 10th"). */
  readonly validTo?: number | null;
  /** The replaced version was WRONG (memory_update correct), not merely outdated. */
  readonly correction?: boolean;
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
  const episodeId = randomUUID();
  // A correction says the old version was WRONG: the new text held from the
  // start, and the wrong one is never offered as the past.
  const corrected =
    input.correction === true && decision.targetId !== null
      ? facts.facts.find((existing) => existing.id === decision.targetId)
      : undefined;
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
      episode: input.text === "" ? null : episodeId,
    },
    validFrom: input.validFrom ?? corrected?.validFrom ?? now,
    validTo: input.validTo ?? null,
    ...(input.basis !== undefined ? { basis: input.basis } : {}),
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
            expiredAt: now,
            ...(corrected !== undefined
              ? { retired: "corrected" as const }
              : { retired: "changed" as const, validTo: fact.validFrom ?? now }),
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
  await recordEpisode(tx, key, input, fact.id, now, episodeId);
  return { id: fact.id, op: decision.op, replaced: decision.targetId, entities: entityIds };
};

/** Provenance: one episode per write (ring of 1,000 full inputs). */
const recordEpisode = async (
  tx: Tx,
  key: string,
  input: WriteFactInput,
  factId: string,
  now: number,
  episodeId: string,
): Promise<void> => {
  if (input.text === "") return;
  const episodes = await tx.doc(EpisodesDoc, key, { episodes: [] });
  const kept = [
    {
      id: episodeId,
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
  const entityIdsIn = (entities: readonly MemoryEntity[]): string[] =>
    entities
      .filter((entity) => entity.mergedInto === null)
      .filter((entity) =>
        extracted.entityNames.some(
          (name) =>
            normalize(entity.name) === normalize(name) ||
            entity.aliases.some((alias) => normalize(alias) === normalize(name)),
        ),
      )
      .map((entity) => entity.id);
  // The DECISION may ask Jev or a model (up to 8 s). It runs here, on a
  // snapshot, never inside the commit: docs.commit is one lock for every
  // durable write in the app, chat admission included.
  const before = await Effect.runPromise(deps.converse.docs.snapshotKeyed(FactsDoc, key)).then(
    (store) => (store?.facts ?? []).filter((fact) => fact.status === "current"),
    () => [] as MemoryFact[],
  );
  refuseWhenFull(before, input);
  const replaces =
    input.replaces === undefined || input.replaces === null
      ? null
      : requireFactRef(input.replaces, before);
  const decideInput = (current: readonly MemoryFact[], entityIds: readonly string[]) => ({
    text: extracted.text,
    tags: input.tags ?? [],
    entityIds,
    triple: extracted.triple,
    ...(replaces !== null ? { replaces } : {}),
    current,
  });
  const planned = await decideWrite(deps, decideInput(before, entityIdsIn(graph)));
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
      refuseWhenFull(current, input);
      // A write that landed meanwhile: decide again on what is there now,
      // by the rules only (no model call under the lock); an ambiguous case
      // then adds and leaves a merge proposal for the tidy.
      const decision = sameFacts(before, current)
        ? planned
        : await decideWrite({}, decideInput(current, entityIdsIn(graphDoc.entities)));
      return applyDecision(tx, { key, input, extracted, decision, current });
    }),
  );
};

/** The hard cap refuses only LOW-importance bot writes; owner and importance ≥3 land. */
const refuseWhenFull = (current: readonly MemoryFact[], input: WriteFactInput): void => {
  if (current.length >= LIMITS.hardFacts && input.writer !== null && (input.importance ?? 3) <= 2) {
    throw new InvalidInput({
      reason: "memory is full; ask the owner to review the tidy suggestions",
    });
  }
};

/** Same current facts, same texts: the decision taken on the snapshot still holds. */
const sameFacts = (a: readonly MemoryFact[], b: readonly MemoryFact[]): boolean =>
  a.length === b.length &&
  a.every((fact, index) => fact.id === b[index]?.id && fact.hash === b[index]?.hash);

export type { WriteOp };
