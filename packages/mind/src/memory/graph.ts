/**
 * The entity graph: entities are people, pets, places, projects; the triple
 * on a fact IS the edge — no separate edge store. Resolution happens inside
 * the write transaction: known names (or aliases) fold to their id, unknown
 * names become new entities deterministically (no model calls). `owner` and
 * a per-bot `self` are reserved ids. Recall expands 1 hop;
 * `memory_related` can ask for 2.
 */
import { randomUUID } from "node:crypto";
import type { MemoryEntity, MemoryFact } from "@spreissen/contracts";
import { Effect } from "effect";
import { NotFound } from "@spreissen/core";
import type { ConverseService } from "../converse/converse.ts";
import { FactsDoc, GraphDoc, ownerKey, profileKey } from "./model.ts";
import { normalize } from "./text.ts";

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

export const RESERVED_IDS = new Set(["owner", "self"]);

/** Resolve names to entities, creating the missing ones. Runs inside a tx. */
export const resolveEntitiesInTx = (
  graph: { entities: MemoryEntity[] },
  names: readonly string[],
  ownerHint: string | null,
): string[] => {
  const ids: string[] = [];
  for (const rawName of names) {
    const name = rawName.trim();
    if (name === "") continue;
    const normalized = normalize(name);
    const existing = graph.entities.find(
      (entity) =>
        entity.mergedInto === null &&
        (normalize(entity.name) === normalized ||
          entity.aliases.some((alias) => normalize(alias) === normalized)),
    );
    if (existing !== undefined) {
      if (!ids.includes(existing.id)) ids.push(existing.id);
      continue;
    }
    const entity: MemoryEntity = {
      id: randomUUID(),
      name,
      type: ownerHint !== null && normalize(ownerHint) === normalized ? "person" : "thing",
      aliases: [],
      summary: "",
      createdAt: Date.now(),
      mergedInto: null,
    };
    graph.entities.push(entity);
    ids.push(entity.id);
  }
  return ids;
};

export interface EntityCard {
  readonly entity: MemoryEntity;
  /** Current facts linked to the entity (importance first). */
  readonly facts: readonly MemoryFact[];
  /** Neighbours within `depth` hops through fact triples. */
  readonly neighbours: readonly { readonly entity: MemoryEntity; readonly via: string }[];
}

const neighboursOf = (
  entityId: string,
  entities: readonly MemoryEntity[],
  facts: readonly MemoryFact[],
): readonly { readonly entity: MemoryEntity; readonly via: string }[] => {
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const out = new Map<string, string>();
  for (const fact of facts) {
    const triple = fact.triple;
    if (triple === null || fact.status !== "current") continue;
    if (triple.s === entityId && byId.has(triple.o)) out.set(triple.o, triple.p);
    if (triple.o === entityId && byId.has(triple.s)) out.set(triple.s, triple.p);
  }
  return [...out]
    .flatMap(([id, via]) => {
      const entity = byId.get(id);
      return entity !== undefined && entity.mergedInto === null ? [{ entity, via }] : [];
    })
    .slice(0, 12);
};

/** The entity card for `memory_related`: current facts plus the neighbourhood. */
export const relatedEntity = async (
  deps: { readonly converse: ConverseService },
  owner: string,
  profileId: string | null,
  entity: string,
  depth: 1 | 2 = 1,
): Promise<EntityCard> => {
  const key = profileId === null ? ownerKey(owner) : profileKey(owner, profileId);
  const [graph, facts] = await Promise.all([
    run(deps.converse.docs.snapshotKeyed(GraphDoc, key)).then((store) => store?.entities ?? []),
    run(deps.converse.docs.snapshotKeyed(FactsDoc, key)).then((store) => store?.facts ?? []),
  ]);
  const normalized = normalize(entity);
  const anchor = graph.find(
    (candidate) =>
      candidate.mergedInto === null &&
      (candidate.id === entity ||
        normalize(candidate.name) === normalized ||
        candidate.aliases.some((alias) => normalize(alias) === normalized)),
  );
  if (anchor === undefined) {
    throw new NotFound({ what: `entity ${entity}` });
  }
  const hop1 = neighboursOf(anchor.id, graph, facts);
  const neighbours =
    depth === 1
      ? hop1
      : [
          ...hop1,
          ...hop1
            .flatMap((hop) =>
              neighboursOf(hop.entity.id, graph, facts).filter(
                (second) => second.entity.id !== anchor.id,
              ),
            )
            .filter((second) => !hop1.some((hop) => hop.entity.id === second.entity.id)),
        ].slice(0, 24);
  return {
    entity: anchor,
    facts: facts
      .filter(
        (fact) =>
          fact.status === "current" &&
          (fact.entities.includes(anchor.id) ||
            fact.triple?.s === anchor.id ||
            fact.triple?.o === anchor.id),
      )
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 15),
    neighbours,
  };
};

/** Read a store's graph. */
export const entitiesOf = (
  deps: { readonly converse: ConverseService },
  owner: string,
  profileId: string | null,
): Promise<readonly MemoryEntity[]> =>
  run(
    deps.converse.docs.snapshotKeyed(
      GraphDoc,
      profileId === null ? ownerKey(owner) : profileKey(owner, profileId),
    ),
  ).then((store) => store?.entities ?? []);
