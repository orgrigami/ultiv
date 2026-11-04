/**
 * Ranked recall: four candidate lists fused by Reciprocal Rank Fusion, then
 * adjusted by trust and scope, gated to current facts, budgeted for the
 * prompt. Pure over its inputs — the service wires docs in.
 *
 * - L1 BM25 (k1 1.2, b 0.75; text ×1, tags ×2, entity names ×2), top 50.
 * - L2 facts linked to entities named in the query, top 30.
 * - L3 1-hop graph neighbours, top 20 (`memory_related` can ask for 2 hops).
 * - L4 importance × recency prior, exp(-ageDays/180).
 * Fusion: RRF (k=60), weights 1.0 / 0.8 / 0.5 / 0.3. Untrusted ×0.7;
 * non-owner instructions never surface; profile facts win ties. History
 * (superseded/archived) appears only when asked for or when the query asks
 * in either language, grouped under the current successor.
 */
import type { CoreLine, MemoryEntity, MemoryFact } from "@spriessen/contracts";
import { handleOf } from "./handles.ts";
import { cachedIndex } from "./search-index.ts";
import { normalize, queryTerms } from "./text.ts";

export interface RecallInput {
  readonly facts: readonly MemoryFact[];
  readonly archive?: readonly MemoryFact[];
  readonly entities?: readonly MemoryEntity[];
  readonly core?: readonly CoreLine[];
  readonly query?: string;
  readonly includeHistory?: boolean;
  readonly limit?: number;
  readonly budgetTokens?: number;
  readonly now?: number;
  /**
   * The full-text legs from the search sidecar (search/facts.ts), already
   * scoped to the pool's stores. Absent (tests, an unavailable sidecar):
   * the in-process BM25 index serves the lexical leg.
   */
  readonly search?: {
    readonly lexical: (query: string, limit: number) => readonly string[];
    readonly fuzzy: (query: string, limit: number) => readonly string[];
  };
  /**
   * Meaning-ranked fact ids for the query (search/vectors.ts), computed
   * before the call; absent without an embedding model. Admitted on its
   * own: finding what a vague question MEANS is the leg's whole point.
   */
  readonly semantic?: readonly string[];
  /** The in-process index cache key: one per pool, so bots don't evict each other. */
  readonly cacheKey?: string;
  /**
   * "What held then": every version valid at this moment — current or
   * since changed/ended — instead of what is current now. Corrected and
   * forgotten versions never count.
   */
  readonly asOf?: number;
}

export interface RecallResult {
  readonly core: readonly CoreLine[];
  /** The surfaced facts, ranked. */
  readonly facts: readonly MemoryFact[];
  /** The budgeted, human/model-readable lines. */
  readonly lines: readonly string[];
  readonly tokens: number;
}

const RRF_K = 60;
const WEIGHTS = { l1: 1.0, l2: 0.8, l3: 0.5, l4: 0.3, grams: 0.3, meaning: 0.8 } as const;
/**
 * The trigram leg admits candidates of its own only when the word leg
 * found almost nothing (a typo, a code, a name spelled differently);
 * otherwise it only reinforces facts the other legs already found.
 */
const GRAMS_ADMIT_BELOW = 3;
const LIMIT_DEFAULT = 10;
const LIMIT_MAX = 25;
const BUDGET_DEFAULT = 600;
const BUDGET_MAX = 1_500;
/** Results below half the top score are dropped. */
const CUT_RATIO = 0.5;
/** Query words that ask for history, in either language. */
const HISTORY_MARKERS = [
  "dulu",
  "dahulu",
  "riwayat",
  "dahulukala",
  "used to",
  "previously",
  "formerly",
];

/**
 * Past, not present: retired versions, and current facts whose known end
 * day has passed ("on leave until the 10th", read on the 12th).
 */
const isHistory = (fact: MemoryFact, now: number): boolean =>
  fact.status === "superseded" ||
  fact.status === "archived" ||
  fact.status === "forgotten" ||
  (fact.validTo !== null && fact.validTo <= now);

const queryAsksHistory = (query: string): boolean => {
  const normalized = ` ${normalize(query)} `;
  return HISTORY_MARKERS.some((marker) => normalized.includes(` ${marker} `));
};

const rrf = (
  lists: readonly { readonly weight: number; readonly ids: readonly string[] }[],
): Map<string, number> => {
  const fused = new Map<string, number>();
  for (const { weight, ids } of lists) {
    for (let rank = 0; rank < ids.length; rank += 1) {
      const id = ids[rank] ?? "";
      fused.set(id, (fused.get(id) ?? 0) + weight / (RRF_K + rank + 1));
    }
  }
  return fused;
};

/** Entity ids whose name or alias appears in the query. */
const entityMatches = (query: string, entities: readonly MemoryEntity[]): readonly string[] => {
  const normalized = ` ${normalize(query)} `;
  const found: string[] = [];
  for (const entity of entities) {
    if (entity.mergedInto !== null) continue;
    const names = [entity.name, ...entity.aliases].map(normalize);
    if (names.some((name) => name !== "" && normalized.includes(` ${name} `))) {
      found.push(entity.id);
    }
  }
  return found;
};

/** L3: neighbours of the matched entities through fact triples (1 hop). */
const neighbours = (
  matched: readonly string[],
  facts: readonly MemoryFact[],
  entities: readonly MemoryEntity[],
): readonly string[] => {
  if (matched.length === 0) return [];
  const known = new Set(entities.map((entity) => entity.id));
  const hop = new Set<string>();
  for (const fact of facts) {
    const triple = fact.triple;
    if (triple === null) continue;
    if (matched.includes(triple.s) && known.has(triple.o)) hop.add(triple.o);
    if (matched.includes(triple.o) && known.has(triple.s)) hop.add(triple.s);
  }
  return [...hop].filter((id) => !matched.includes(id));
};

const prior = (fact: MemoryFact, now: number): number =>
  fact.importance * Math.exp(-(now - fact.confirmedAt) / (180 * 24 * 3_600_000));

/** L2/L3: facts linked to the given entity ids, best first, capped. */
const factsForEntities = (
  ids: readonly string[],
  facts: readonly MemoryFact[],
  cap: number,
): readonly string[] =>
  facts
    .filter((fact) => fact.entities.some((id) => ids.includes(id)))
    .sort((a, b) => b.importance - a.importance)
    .slice(0, cap)
    .map((fact) => fact.id);

/**
 * The ranked recall for one store. `now` defaults to Date.now(); visible
 * facts are current unless history is asked for; forgotten facts never
 * surface (they are tombstones for Purge).
 */
export const recall = (input: RecallInput): RecallResult => {
  const now = input.now ?? Date.now();
  const limit = Math.min(input.limit ?? LIMIT_DEFAULT, LIMIT_MAX);
  const budget = Math.min(input.budgetTokens ?? BUDGET_DEFAULT, BUDGET_MAX);
  const query = input.query?.trim() ?? "";
  const wantHistory = input.includeHistory === true || (query !== "" && queryAsksHistory(query));
  const entities = input.entities ?? [];
  const core = input.core ?? [];

  const asOf = input.asOf;
  const heldAt = (fact: MemoryFact, at: number): boolean =>
    (fact.validFrom ?? fact.createdAt) <= at && (fact.validTo === null || fact.validTo > at);
  const visible = input.facts.filter(
    (fact) =>
      fact.status !== "forgotten" &&
      // A corrected version was wrong: it is never offered, not even as the past.
      fact.retired !== "corrected" &&
      // Instructions surface by TRUST, not scope: the owner's own standing
      // instructions (owner or self trust) rank in; derived/untrusted
      // instruction-shaped text from outside content never does.
      !(fact.kind === "instruction" && (fact.trust === "derived" || fact.trust === "untrusted")) &&
      (asOf !== undefined
        ? fact.status !== "archived" && heldAt(fact, asOf)
        : wantHistory || !isHistory(fact, now)),
  );
  const pool = wantHistory ? [...visible, ...(input.archive ?? [])] : visible;

  if (query === "") {
    const top = [...visible]
      .filter((fact) => asOf !== undefined || !isHistory(fact, now))
      .sort((a, b) => prior(b, now) - prior(a, now))
      .slice(0, limit);
    return render({ core, facts: top, now, budget });
  }

  const namesOf = (entityId: string): readonly string[] => {
    const entity = entities.find((candidate) => candidate.id === entityId);
    return entity === undefined ? [] : [entity.name, ...entity.aliases];
  };
  const signature = `${pool.length}:${entities.map((e) => `${e.id}:${e.name}:${e.aliases.join("|")}`).join(";")}:${pool
    .map((fact) => fact.id)
    .join(",")}`;
  const inPool = new Set(pool.map((fact) => fact.id));
  const l1 =
    input.search !== undefined
      ? input.search.lexical(query, 50).filter((id) => inPool.has(id))
      : cachedIndex(input.cacheKey ?? "recall", pool, namesOf, signature)
          .search(queryTerms(query))
          .slice(0, 50)
          .map((entry) => entry.id);
  const grams =
    input.search !== undefined ? input.search.fuzzy(query, 20).filter((id) => inPool.has(id)) : [];
  const matched = entityMatches(query, entities);
  const l2 = factsForEntities(matched, pool, 30);
  const l3 = factsForEntities(neighbours(matched, pool, entities), pool, 20);
  // L4 is a PRIOR over the candidates, not a fourth candidate source: textual
  // or entity evidence must exist before recency/importance can surface a fact.
  const meaning = (input.semantic ?? []).filter((id) => inPool.has(id));
  const found = new Set([...l1, ...l2, ...l3, ...meaning]);
  const admitGrams = found.size < GRAMS_ADMIT_BELOW;
  const gramLeg = admitGrams ? grams : grams.filter((id) => found.has(id));
  const candidates = [...new Set([...found, ...gramLeg])];
  const priorById = new Map(pool.map((entry) => [entry.id, entry]));
  const l4 = candidates
    .map((id) => priorById.get(id))
    .filter((entry): entry is MemoryFact => entry !== undefined)
    .sort((a, b) => prior(b, now) - prior(a, now))
    .map((entry) => entry.id);

  const fused = rrf([
    { weight: WEIGHTS.l1, ids: l1 },
    { weight: WEIGHTS.l2, ids: l2 },
    { weight: WEIGHTS.l3, ids: l3 },
    { weight: WEIGHTS.l4, ids: l4 },
    { weight: WEIGHTS.grams, ids: gramLeg },
    { weight: WEIGHTS.meaning, ids: meaning },
  ]);
  const byId = new Map(pool.map((fact) => [fact.id, fact]));
  const ranked = [...fused]
    .map(([id, score]) => {
      const fact = byId.get(id);
      if (fact === undefined) return null;
      const trust = fact.trust === "untrusted" ? 0.7 : 1;
      // Profile facts win ties: a hair of extra weight, applied last.
      const scope = fact.scope === "profile" ? 1.000001 : 1;
      return { fact, score: score * trust * scope };
    })
    .filter((entry): entry is { fact: MemoryFact; score: number } => entry !== null)
    .sort((a, b) => b.score - a.score || b.fact.confirmedAt - a.fact.confirmedAt);

  const topScore = ranked[0]?.score ?? 0;
  const cut = ranked.filter((entry) => entry.score >= topScore * CUT_RATIO);
  const superseded = new Map(
    pool
      .filter((fact) => fact.supersededBy !== null && fact.supersededBy !== undefined)
      .map((fact) => [fact.id, fact.supersededBy as string]),
  );
  const successorOf = (id: string): string | null => {
    let cursor: string | null = superseded.get(id) ?? null;
    const seen = new Set<string>();
    while (cursor !== null && superseded.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = superseded.get(cursor) ?? null;
    }
    return cursor;
  };
  return render({
    core,
    facts: cut.slice(0, limit).map((entry) => entry.fact),
    now,
    budget,
    successor: (id) => {
      const successorId = successorOf(id);
      return successorId === null ? null : (byId.get(successorId)?.text ?? null);
    },
  });
};

const dateOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

/**
 * One model-facing fact line: its handle first (the only id the model ever
 * sees — memory_update/forget/history take it), then the text and the
 * bits that change how far to lean on it.
 */
export const factLine = (fact: MemoryFact, successor: string | null = null): string => {
  const bits = [`since ${dateOf(fact.validFrom ?? fact.createdAt)}`];
  if (fact.validTo !== null) bits.push(`until ${dateOf(fact.validTo)}`);
  if (fact.confirmedAt !== fact.createdAt) bits.push(`confirmed ${dateOf(fact.confirmedAt)}`);
  if (fact.trust === "untrusted") bits.push(`unverified, from ${fact.source.via}`);
  else if (fact.basis === "inferred") bits.push("inferred, unconfirmed");
  const past = successor !== null ? ` [superseded by: ${successor}]` : "";
  return `${handleOf(fact.id)} ${fact.text}${past} (${bits.join(" · ")})`;
};

const render = (input: {
  readonly core: readonly CoreLine[];
  readonly facts: readonly MemoryFact[];
  readonly now: number;
  readonly budget: number;
  readonly successor?: (id: string) => string | null;
}): RecallResult => {
  const lines: string[] = [];
  let tokens = 0;
  const push = (line: string): void => {
    const cost = Math.ceil(line.length / 4) + 1;
    if (tokens + cost > input.budget) return;
    tokens += cost;
    lines.push(line);
  };
  for (const line of input.core) push(`core: ${line.text}`);
  for (const fact of input.facts) push(factLine(fact, input.successor?.(fact.id) ?? null));
  return { core: input.core, facts: input.facts, lines, tokens };
};
