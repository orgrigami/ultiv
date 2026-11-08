/**
 * The daily spend ledger: every committed assistant message's tokens, summed
 * per profile per day (the server's local day). The sink is wired by the
 * entity into the converse service, so chats, tasks, routines and evals all
 * land here; a profile's `policies.dailyTokenBudget` (null = none) gates
 * TASK admission (tasks/queue.ts) — the budget bounds autonomous work, not
 * conversations with the owner. Derived views (REST, Edit bot) read the same
 * doc. Rows are kept for the last USAGE_DAYS days per profile.
 */
import { defineDoc } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import type { ConverseService } from "../converse/converse.ts";
import type { TurnUsage, UsageSink } from "../converse/converse.ts";

/** How many days of spend stay readable per profile. */
export const USAGE_DAYS = 30;

type StoredUsage = {
  days: Record<string, Record<string, number>>;
};

export const UsageDoc = defineDoc<StoredUsage>({
  kind: "ultiv.usage",
  version: 1,
  scope: "session",
  initial: () => ({ days: {} }),
  checkpointWhen: () => true,
});

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

/** The local calendar day, `yyyy-mm-dd` (the server's timezone draws the line). */
export const usageDay = (at: number = Date.now()): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
  return parts;
};

const keyOf = (owner: string, profileId: string): string => `${owner}:${profileId}`;

/** Parse a stored ledger key back into owner and profile. */
export const profileOfKey = (key: string): { owner: string; profileId: string } => {
  const at = key.indexOf(":");
  return { owner: key.slice(0, at), profileId: key.slice(at + 1) };
};

/** One profile's spend, newest day first. */
export interface UsageRow {
  readonly day: string;
  readonly tokens: number;
}

export interface UsageService {
  /** Add a settled turn's spend to a profile's today row. */
  readonly add: (owner: string, profileId: string, usage: TurnUsage) => Promise<void>;
  /** One profile's rows (newest first) plus its today total. */
  readonly of: (owner: string, profileId: string) => Promise<readonly UsageRow[]>;
  /** One profile's spend today (0 when nothing ran). */
  readonly today: (owner: string, profileId: string) => Promise<number>;
}

export const usageService = (converse: ConverseService): UsageService => ({
  add: async (owner, profileId, usage) => {
    const key = keyOf(owner, profileId);
    const day = usageDay();
    await run(
      converse.docs.commit(async (tx) => {
        const draft = await tx.doc(UsageDoc);
        const mine = draft.days[key] ?? {};
        mine[day] = (mine[day] ?? 0) + usage.totalTokens;
        // Keep the window bounded: oldest days fall off.
        const kept = Object.keys(mine).toSorted().slice(-USAGE_DAYS);
        draft.days[key] = Object.fromEntries(kept.map((keptDay) => [keptDay, mine[keptDay] ?? 0]));
      }),
    );
  },
  of: async (owner, profileId) => {
    const snapshot = await run(converse.docs.snapshot(UsageDoc));
    const mine = snapshot?.days[keyOf(owner, profileId)] ?? {};
    return Object.entries(mine)
      .map(([day, tokens]) => ({ day, tokens }))
      .toSorted((a, b) => (a.day < b.day ? 1 : -1));
  },
  today: async (owner, profileId) => {
    const snapshot = await run(converse.docs.snapshot(UsageDoc));
    return snapshot?.days[keyOf(owner, profileId)]?.[usageDay()] ?? 0;
  },
});

/**
 * The sink the entity wires into the converse service: resolve the spending
 * conversation's profile, then record. Owner-less conversations (the owner's
 * own scope, tests) record under the owner key with no profile.
 */
export const usageSinkOf =
  (deps: {
    readonly converse: ConverseService;
    readonly usage: UsageService;
    readonly scopeOf: (
      conversationId: string,
    ) => { readonly owner: string; readonly profileId: string } | undefined;
  }): UsageSink =>
  (conversationId, usage) => {
    const scope = deps.scopeOf(conversationId);
    if (scope === undefined) return;
    void deps.usage
      .add(scope.owner, scope.profileId, usage)
      .catch((cause: unknown) => console.error("usage ledger write failed:", cause));
  };
