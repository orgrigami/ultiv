/**
 * The write decision: what happens when a fact arrives. Rules first, then
 * Jev (when configured), then a generate fallback — and on any failure an
 * ADD plus a merge proposal for the tidy. Nothing is ever deleted: refine
 * and supersede create new versions and keep the history.
 *
 * 1. Exact hash duplicate            → noop (bump confirmedAt, merge tags)
 * 2. Near-duplicate (Jaccard ≥ 0.85,
 *    same entities)                  → noop
 * 3. Functional predicate, same
 *    subject, new object             → supersede
 * 4. Explicit `replaces`             → supersede (or refine when similar
 *                                      and non-conflicting)
 * 5. Nothing similar (score < 0.35)  → add
 * 6. Ambiguous                       → Jev `pick`, else generate —
 *                                      failure/8 s → add + merge proposal
 */
import type { DecideService } from "../decide/decide.ts";
import type { GenerateService } from "../generate/generate.ts";
import type { MemoryFact } from "@spreissen/contracts";
import { Effect } from "effect";
import { Type } from "typebox";
import { factHash } from "./model.ts";
import { indexTerms } from "./text.ts";

export type WriteOp = "add" | "noop" | "supersede" | "refine";

export interface WriteDecision {
  readonly op: WriteOp;
  /** The existing fact the decision acts on (noop/supersede/refine). */
  readonly targetId: string | null;
  /** For refine: the merged text. */
  readonly mergedText: string | null;
  /** How the decision was reached. */
  readonly via: "rule" | "jev" | "generate" | "fallback";
}

export interface DecideDeps {
  readonly decide?: DecideService;
  readonly generate?: GenerateService;
}

/** Functional predicates: a newer object for the same subject WINS. */
const FUNCTIONAL = new Set([
  "name_is",
  "lives_in",
  "works_at",
  "role_is",
  "timezone_is",
  "born_on",
  "birthday_on",
  "spouse_of",
  "status_is",
  "located_in",
]);

const jaccard = (a: readonly string[], b: readonly string[]): number => {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  let shared = 0;
  for (const term of setA) if (setB.has(term)) shared += 1;
  return shared / (setA.size + setB.size - shared);
};

const similarity = (a: readonly string[], b: readonly string[]): number =>
  jaccard(indexTerms(a.join(" ")), indexTerms(b.join(" ")));

export interface DecideInput {
  readonly text: string;
  readonly tags: readonly string[];
  readonly entityIds: readonly string[];
  readonly triple: MemoryFact["triple"];
  /** An explicit replacement target (tool arg `replaces`). */
  readonly replaces?: string | null;
  /** The store's CURRENT facts, candidates for consolidation. */
  readonly current: readonly MemoryFact[];
}

const bestMatch = (input: DecideInput): { fact: MemoryFact; score: number } | null => {
  let best: { fact: MemoryFact; score: number } | null = null;
  for (const fact of input.current) {
    const score = similarity([input.text], [fact.text]);
    if (best === null || score > best.score) best = { fact, score };
  }
  return best;
};

/** Rule 3: functional predicate, same subject, different object. */
const functionalSupersede = (input: DecideInput): MemoryFact | null => {
  const triple = input.triple;
  if (triple === null || !FUNCTIONAL.has(triple.p)) return null;
  return (
    input.current.find(
      (fact) =>
        fact.triple !== null &&
        fact.triple.p === triple.p &&
        fact.triple.s === triple.s &&
        fact.triple.o !== triple.o,
    ) ?? null
  );
};

const MergeSchema = Type.Object({
  op: Type.Union([Type.Literal("supersede"), Type.Literal("refine"), Type.Literal("add")]),
  mergedText: Type.Union([Type.Null(), Type.String()]),
});

const askJev = async (
  deps: DecideDeps,
  input: DecideInput,
  target: MemoryFact,
): Promise<WriteDecision> => {
  const run = async (): Promise<WriteDecision | null> => {
    if (deps.decide?.available === true) {
      const answer = await Effect.runPromise(
        deps.decide.pick("A new memory fact arrives. Which applies?", [
          `replace: drop "${target.text}" and keep only the new fact`,
          `merge: keep one fact combining both — answer MERGED:<the merged sentence>`,
          `keep both as separate facts`,
        ]),
      );
      if (answer.startsWith("replace")) {
        return { op: "supersede", targetId: target.id, mergedText: null, via: "jev" };
      }
      if (answer.startsWith("merge")) {
        const merged = answer.slice("merge:".length).trim() || `${target.text} (${input.text})`;
        return { op: "refine", targetId: target.id, mergedText: merged, via: "jev" };
      }
      return { op: "add", targetId: null, mergedText: null, via: "jev" };
    }
    return null;
  };
  const generate = async (): Promise<WriteDecision> => {
    if (deps.generate !== undefined) {
      const extracted = await Effect.runPromise(
        deps.generate.extract({
          prompt:
            `Existing fact: "${target.text}"\nNew fact: "${input.text}"\n` +
            `Decide: supersede (new replaces old), refine (one merged sentence), or add (both). ` +
            `For refine set mergedText.`,
          maxTokens: 2_048,
          schema: MergeSchema,
        }),
      );
      const op = extracted.op;
      if (op === "supersede" || op === "add") {
        return {
          op,
          targetId: op === "supersede" ? target.id : null,
          mergedText: null,
          via: "generate",
        };
      }
      return {
        op: "refine",
        targetId: target.id,
        mergedText: extracted.mergedText ?? `${target.text} (${input.text})`,
        via: "generate",
      };
    }
    return { op: "add", targetId: null, mergedText: null, via: "fallback" };
  };
  try {
    const jev = await run();
    if (jev !== null) return jev;
    return await Promise.race([
      generate(),
      new Promise<WriteDecision>((resolve) =>
        setTimeout(
          () => resolve({ op: "add", targetId: null, mergedText: null, via: "fallback" }),
          8_000,
        ),
      ),
    ]);
  } catch {
    return { op: "add", targetId: null, mergedText: null, via: "fallback" };
  }
};

/**
 * The decision for one incoming fact. `input.current` must already be
 * filtered to the store's current facts (history never consolidates).
 */
export const decideWrite = async (deps: DecideDeps, input: DecideInput): Promise<WriteDecision> => {
  // Rule 1: exact hash duplicate.
  const hash = factHash(input.text);
  const exact = input.current.find((fact) => fact.hash === hash);
  if (exact !== undefined) {
    return { op: "noop", targetId: exact.id, mergedText: null, via: "rule" };
  }
  // Rule 2: near-duplicate (high Jaccard, same entities).
  const match = bestMatch(input);
  if (
    match !== null &&
    match.score >= 0.85 &&
    match.fact.entities.every((id) => input.entityIds.includes(id))
  ) {
    return { op: "noop", targetId: match.fact.id, mergedText: null, via: "rule" };
  }
  // Rule 3: functional predicate supersede.
  const functional = functionalSupersede(input);
  if (functional !== null) {
    return { op: "supersede", targetId: functional.id, mergedText: null, via: "rule" };
  }
  // Rule 4: explicit replaces — refine when similar and non-conflicting.
  const explicit =
    input.replaces !== undefined && input.replaces !== null
      ? (input.current.find((fact) => fact.id === input.replaces) ?? null)
      : null;
  if (explicit !== null) {
    const similar = similarity([input.text], [explicit.text]) >= 0.5;
    if (similar) {
      return {
        op: "refine",
        targetId: explicit.id,
        mergedText: input.text,
        via: "rule",
      };
    }
    return { op: "supersede", targetId: explicit.id, mergedText: null, via: "rule" };
  }
  // Rule 5: nothing similar.
  if (match === null || match.score < 0.35) {
    return { op: "add", targetId: null, mergedText: null, via: "rule" };
  }
  // Rule 6: ambiguous — Jev, then generate, then add + a merge proposal.
  return askJev(deps, input, match.fact);
};
