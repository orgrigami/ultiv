/**
 * The lifecycle acts that need no new text: `end` (a fact stops holding and
 * nothing replaces it — today, or on a known future day) and `confirm` (the
 * owner says it again or agrees). Changes and corrections are writes (they
 * carry a new text) and go through the consolidating write path.
 *
 * Both take a #handle, look in the bot's own store, then the owner store,
 * and follow the forget rule for authority: an owner-stated fact moves only
 * when the owner asked in that very turn, untainted.
 */
import { Effect } from "effect";
import { InvalidInput, NotFound } from "@spriessen/core";
import type { MemoryFact } from "@spriessen/contracts";
import type { AuditService } from "../audit/audit.ts";
import type { ConverseService } from "../converse/converse.ts";
import { FactsDoc, ownerKey, profileKey } from "./model.ts";
import { contextOf, type WriteContext } from "./guard.ts";
import { forgetVerdict } from "./forget.ts";
import { resolveFactRef } from "./handles.ts";

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

export interface LifecycleDeps {
  readonly converse: ConverseService;
  readonly audit?: AuditService;
  readonly untrustedTool?: (name: string) => boolean;
}

interface Located {
  readonly key: string;
  readonly fact: MemoryFact;
}

/** The CURRENT fact a handle names, in the bot's store or the owner store. */
const locate = async (
  converse: ConverseService,
  owner: string,
  profileId: string | null,
  ref: string,
): Promise<Located> => {
  const keys =
    profileId === null ? [ownerKey(owner)] : [profileKey(owner, profileId), ownerKey(owner)];
  for (const key of keys) {
    const facts = await run(converse.docs.snapshotKeyed(FactsDoc, key)).then(
      (store) => store?.facts ?? [],
    );
    const id = resolveFactRef(ref, facts);
    const fact = id === undefined ? undefined : facts.find((candidate) => candidate.id === id);
    if (fact === undefined) continue;
    if (fact.status !== "current") {
      throw new InvalidInput({
        reason: `${ref} is no longer current (${fact.retired ?? fact.status}); recall again for the current version`,
      });
    }
    return { key, fact };
  }
  throw new NotFound({ what: `fact ${ref.trim()} (use a #handle from memory_recall)` });
};

const turnOf = async (
  deps: LifecycleDeps,
  conversationId: string | null,
): Promise<WriteContext | null> =>
  conversationId === null || deps.audit === undefined
    ? null
    : contextOf(deps, conversationId).catch(() => null);

/** Rewrite one fact of one store inside a commit. */
const patch = (
  converse: ConverseService,
  key: string,
  id: string,
  change: (fact: MemoryFact) => MemoryFact,
): Promise<void> =>
  run(
    converse.docs.commit(async (tx) => {
      const store = await tx.doc(FactsDoc, key, { facts: [], migratedAt: null });
      store.facts = store.facts.map((fact) => (fact.id === id ? change(fact) : fact));
    }),
  );

/**
 * End a fact: from `at` (default now) it no longer holds. A past or present
 * end retires it now; a future end keeps it current, shown with its end
 * day, and recall drops it once the day has passed.
 */
export const endFact = async (
  deps: LifecycleDeps,
  owner: string,
  profileId: string | null,
  ref: string,
  at: number | undefined,
  conversationId: string | null,
): Promise<{ readonly id: string; readonly endsAt: number; readonly retired: boolean }> => {
  const { key, fact } = await locate(deps.converse, owner, profileId, ref);
  const verdict = forgetVerdict(fact, await turnOf(deps, conversationId));
  if (!verdict.ok) throw new InvalidInput({ reason: verdict.reason ?? "refused" });
  const now = Date.now();
  const endsAt = at ?? now;
  const retired = endsAt <= now;
  await patch(deps.converse, key, fact.id, (current) =>
    retired
      ? {
          ...current,
          status: "superseded",
          retired: "ended",
          validTo: endsAt,
          expiredAt: now,
        }
      : { ...current, validTo: endsAt },
  );
  return { id: fact.id, endsAt, retired };
};

/**
 * The owner confirmed a fact (said it again, or agreed when asked): it is
 * fresher, surer, and an inference becomes a confirmed one. Only a clean
 * owner turn may confirm — a page or another bot agreeing is no confirmation.
 */
export const confirmFact = async (
  deps: LifecycleDeps,
  owner: string,
  profileId: string | null,
  ref: string,
  conversationId: string | null,
): Promise<{ readonly id: string; readonly confirmations: number }> => {
  const { key, fact } = await locate(deps.converse, owner, profileId, ref);
  const turn = await turnOf(deps, conversationId);
  if (turn !== null && (turn.origin !== "owner" || turn.tainted)) {
    throw new InvalidInput({
      reason: "only the owner confirms a fact, in their own turn; this turn is not theirs",
    });
  }
  const confirmations = (fact.confirmations ?? 0) + 1;
  await patch(deps.converse, key, fact.id, (current) => ({
    ...current,
    confirmedAt: Date.now(),
    confidence: Math.min(1, Math.max(current.confidence, 0.9)),
    confirmations,
    ...(current.basis === "inferred" ? { basis: "confirmed" as const } : {}),
  }));
  return { id: fact.id, confirmations };
};
