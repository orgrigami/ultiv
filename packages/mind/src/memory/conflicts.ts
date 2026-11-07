/**
 * Contradictions between current facts, found without a model call (after
 * hermes-plugin-holographic's `contradict`, MIT, reimplemented): two facts
 * about the same subject making a similar but different claim — "Harry
 * lives in Jakarta" / "Harry lives in Bandung", a changed number, a flipped
 * preference. The weekly tidy turns each into a `conflict` proposal; the
 * owner picks which holds.
 *
 * - Definite: the same functional relation of the same subject with
 *   another value (normalized triples: lives_in, works_at, …).
 * - Likely: facts sharing entities (overlap ≥ ENTITY_OVERLAP) whose claims
 *   — their words with the entity names left out — overlap between
 *   CLAIM_MIN and CLAIM_MAX, where neither claim only adds detail to the
 *   other ("likes apples" / "likes apples and pears" is no conflict).
 */
import type { MemoryEntity, MemoryFact } from "@spriessen/contracts";
import { isFunctional, normalizeTriple, sameTerm } from "./predicates.ts";
import { indexTerms } from "./text.ts";

export const ENTITY_OVERLAP = 0.3;
export const CLAIM_MIN = 0.3;
export const CLAIM_MAX = 0.85;
/** Facts compared per store: the most recently confirmed. */
const WINDOW = 500;

export interface Conflict {
  /** The older fact first; the owner's accept names the one that holds. */
  readonly older: MemoryFact;
  readonly newer: MemoryFact;
  readonly score: number;
  readonly reason: "same relation, another value" | "similar claims about the same subject";
}

const startOf = (fact: MemoryFact): number => fact.validFrom ?? fact.createdAt;

const ordered = (a: MemoryFact, b: MemoryFact): [MemoryFact, MemoryFact] =>
  startOf(a) <= startOf(b) ? [a, b] : [b, a];

const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  let shared = 0;
  for (const term of a) if (b.has(term)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
};

const subset = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  [...a].every((term) => b.has(term));

/** Candidate contradictions among a store's current facts, strongest first. */
export const detectConflicts = (
  facts: readonly MemoryFact[],
  entities: readonly MemoryEntity[],
  limit = 10,
): Conflict[] => {
  const current = facts
    .filter((fact) => fact.status === "current" && fact.retired === undefined)
    .sort((a, b) => b.confirmedAt - a.confirmedAt)
    .slice(0, WINDOW);
  const nameTerms = new Map(
    entities.map((entity) => [
      entity.id,
      new Set([entity.name, ...entity.aliases].flatMap((name) => indexTerms(name))),
    ]),
  );
  const claimOf = (fact: MemoryFact): Set<string> => {
    const drop = new Set(fact.entities.flatMap((id) => [...(nameTerms.get(id) ?? [])]));
    return new Set(
      indexTerms(fact.text).filter((term) => !term.startsWith("§") && !drop.has(term)),
    );
  };
  const claims = new Map(current.map((fact) => [fact.id, claimOf(fact)]));
  const found = new Map<string, Conflict>();
  const keep = (a: MemoryFact, b: MemoryFact, score: number, reason: Conflict["reason"]) => {
    const [older, newer] = ordered(a, b);
    const key = `${older.id}|${newer.id}`;
    const prior = found.get(key);
    if (prior === undefined || prior.score < score) found.set(key, { older, newer, score, reason });
  };
  // Pairs that share an entity (or a triple subject): group, never all-pairs.
  const groups = new Map<string, MemoryFact[]>();
  for (const fact of current) {
    const triple = normalizeTriple(fact.triple);
    const keys = [...fact.entities, ...(triple !== null ? [`s:${triple.s.toLowerCase()}`] : [])];
    for (const key of keys) groups.set(key, [...(groups.get(key) ?? []), fact]);
  }
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i];
        const b = group[j];
        if (a === undefined || b === undefined || a.hash === b.hash) continue;
        const ta = normalizeTriple(a.triple);
        const tb = normalizeTriple(b.triple);
        if (
          ta !== null &&
          tb !== null &&
          ta.p === tb.p &&
          isFunctional(ta.p) &&
          sameTerm(ta.s, tb.s) &&
          !sameTerm(ta.o, tb.o)
        ) {
          keep(a, b, 1, "same relation, another value");
          continue;
        }
        const ea = new Set(a.entities);
        const eb = new Set(b.entities);
        const overlap = jaccard(ea, eb);
        if (overlap < ENTITY_OVERLAP) continue;
        const ca = claims.get(a.id) ?? new Set<string>();
        const cb = claims.get(b.id) ?? new Set<string>();
        if (ca.size === 0 || cb.size === 0 || subset(ca, cb) || subset(cb, ca)) continue;
        const similar = jaccard(ca, cb);
        if (similar < CLAIM_MIN || similar >= CLAIM_MAX) continue;
        keep(a, b, overlap * similar, "similar claims about the same subject");
      }
    }
  }
  return [...found.values()].sort((x, y) => y.score - x.score).slice(0, limit);
};
