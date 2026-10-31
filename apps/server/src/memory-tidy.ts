/**
 * The weekly memory tidy: Sundays 09:00 WIB by default (`MEMORY_TIDY_CRON`),
 * croner-scheduled, NOT a bot turn, costs no tokens (the optional LLM pass is
 * off). Deterministic detectors write PROPOSALS — nothing changes without the
 * owner's accept. Receipts land in `ultiv.routine-events`; a missed week
 * (> 8 days) catches up on boot. Manual run: POST /api/memory/tidy/run.
 */
import { Cron } from "croner";
import { randomUUID } from "node:crypto";
import type { MemoryFact, MemoryProposal } from "@spreissen/contracts";
import { Effect } from "effect";
import {
  FactsDoc,
  ProfilesDoc,
  ProposalsDoc,
  listRoutineEvents,
  normalize,
  ownerKey,
  profileKey,
  recordRoutineFire,
  type MindService,
} from "@spreissen/mind";

const TIDY_ROUTINE_ID = "memory-tidy";
const CATCH_UP_DAYS = 8;
const OPEN_CAP = 50;
const TTL_MS = 30 * 24 * 3_600_000;
const BACKFILL_PER_RUN = 20;

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

export const tidyCron = (): string => process.env.MEMORY_TIDY_CRON ?? "0 9 * * 0";

export interface TidyDeps {
  readonly mind: MindService;
  /** The push notifier; tidy sends "Memory tidy: N suggestions" (no fact text). */
  readonly notify?: (owner: string, text: string) => Promise<void>;
}

const fingerprintOf = (...parts: readonly string[]): string => [...parts].sort().join("|");

/** ---- detectors (pure over a store's facts) ------------------------------ */

export const detectStale = (facts: readonly MemoryFact[]): readonly MemoryProposal[] =>
  facts
    .filter(
      (fact) =>
        fact.status === "current" &&
        fact.trust !== "owner" &&
        Date.now() - fact.confirmedAt > 180 * 24 * 3_600_000 &&
        fact.importance <= 2,
    )
    .slice(0, 10)
    .map((fact) => ({
      id: randomUUID(),
      kind: "stale" as const,
      at: Date.now(),
      factIds: [fact.id],
      summary: `Unconfirmed for 6+ months and low importance: "${fact.text.slice(0, 100)}" — archive it?`,
      fingerprint: fingerprintOf("stale", fact.id),
      status: "open" as const,
      decidedAt: null,
    }));

export const detectMerge = (facts: readonly MemoryFact[]): readonly MemoryProposal[] => {
  const current = facts.filter((fact) => fact.status === "current");
  const out: MemoryProposal[] = [];
  for (let i = 0; i < current.length && out.length < 10; i += 1) {
    for (let j = i + 1; j < current.length && out.length < 10; j += 1) {
      const a = current[i];
      const b = current[j];
      if (a !== undefined && b !== undefined && a.hash === b.hash) {
        out.push({
          id: randomUUID(),
          kind: "merge",
          at: Date.now(),
          factIds: [a.id, b.id],
          summary: `Exact duplicates: "${a.text.slice(0, 80)}" — merge?`,
          fingerprint: fingerprintOf("merge", a.id, b.id),
          status: "open",
          decidedAt: null,
        });
        break;
      }
    }
  }
  return out;
};

const SECRET_IN_FACT =
  /\b(sk-[A-Za-z0-9_-]{16,}|xox[abp]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/;

export const detectSecrets = (facts: readonly MemoryFact[]): readonly MemoryProposal[] =>
  facts
    .filter((fact) => fact.status === "current" && SECRET_IN_FACT.test(fact.text))
    .slice(0, 5)
    .map((fact) => ({
      id: randomUUID(),
      kind: "secret" as const,
      at: Date.now(),
      factIds: [fact.id],
      summary:
        "A fact looks like it contains a credential — move it to the vault and forget this fact.",
      fingerprint: fingerprintOf("secret", fact.id),
      status: "open",
      decidedAt: null,
    }));

/** Backfill: link facts with no entities to names already in the graph. */
export const backfillEntityIds = (
  facts: readonly MemoryFact[],
  entityNames: readonly { readonly id: string; readonly names: readonly string[] }[],
  cap = BACKFILL_PER_RUN,
): readonly { readonly factId: string; readonly entityIds: readonly string[] }[] => {
  const out: { factId: string; entityIds: string[] }[] = [];
  for (const fact of facts) {
    if (out.length >= cap) break;
    if (fact.status !== "current" || fact.entities.length > 0) continue;
    const normalized = normalize(fact.text);
    const ids = entityNames
      .filter((entry) => entry.names.some((name) => normalized.includes(normalize(name))))
      .map((entry) => entry.id);
    if (ids.length > 0) out.push({ factId: fact.id, entityIds: ids });
  }
  return out;
};

/** ---- the tidy pass over one store --------------------------------------- */

const coreFixes = async (
  deps: TidyDeps,
  owner: string,
  profileId: string | null,
  supersededIds: ReadonlySet<string>,
): Promise<readonly MemoryProposal[]> => {
  const lines = await deps.mind.memory.core.read(owner, profileId);
  return lines
    .filter((line) => line.factId !== null && supersededIds.has(line.factId))
    .map((line) => ({
      id: randomUUID(),
      kind: "core-fix" as const,
      at: Date.now(),
      factIds: [line.factId ?? ""],
      summary: `Core line "${line.text.slice(0, 60)}" points at a superseded fact — update it?`,
      fingerprint: fingerprintOf("core-fix", line.id),
      status: "open" as const,
      decidedAt: null,
    }));
};

export const tidyStore = async (
  deps: TidyDeps,
  owner: string,
  profileId: string | null,
): Promise<{ created: number }> => {
  const key = profileId === null ? ownerKey(owner) : profileKey(owner, profileId);
  const facts = await deps.mind.memory.readFacts(owner, profileId);
  const detected = [
    ...detectStale(facts),
    ...detectMerge(facts),
    ...detectSecrets(facts),
    ...(await coreFixes(
      deps,
      owner,
      profileId,
      new Set(facts.filter((fact) => fact.status === "superseded").map((fact) => fact.id)),
    )),
  ];
  const created = await run(
    deps.mind.converse.docs.commit<number>(async (tx) => {
      const store = await tx.doc(ProposalsDoc, key, { proposals: [] });
      const now = Date.now();
      // Expire proposals past 30 days. REJECTED ones stay in the store: their
      // fingerprints keep the detector from proposing the same thing again
      // next run (the REST read filters them from display).
      const existing = store.proposals.filter(
        (proposal) => !(proposal.status === "open" && now - proposal.at > TTL_MS),
      );
      const known = new Set(store.proposals.map((proposal) => proposal.fingerprint));
      const fresh = detected.filter((proposal) => !known.has(proposal.fingerprint));
      const open = existing.filter((proposal) => proposal.status === "open");
      const room = Math.max(0, OPEN_CAP - open.length);
      store.proposals = [...fresh.slice(0, room), ...existing].slice(0, 200);
      return fresh.length;
    }),
  );
  return { created };
};

/** Deterministic entity backfill applies directly: pure link inference. */
export const applyBackfill = async (
  deps: TidyDeps,
  owner: string,
  profileId: string | null,
): Promise<number> => {
  const key = profileId === null ? ownerKey(owner) : profileKey(owner, profileId);
  const facts = await deps.mind.memory.readFacts(owner, profileId);
  const names = (await deps.mind.memory.entities(owner, profileId)).map((entity) => ({
    id: entity.id,
    names: [entity.name, ...entity.aliases],
  }));
  const plan = backfillEntityIds(facts, names);
  if (plan.length === 0) return 0;
  await run(
    deps.mind.converse.docs.commit(async (tx) => {
      const store = await tx.doc(FactsDoc, key, { facts: [], migratedAt: null });
      store.facts = store.facts.map((fact) => {
        const found = plan.find((entry) => entry.factId === fact.id);
        return found === undefined
          ? fact
          : { ...fact, entities: [...new Set([...fact.entities, ...found.entityIds])] };
      });
    }),
  );
  return plan.length;
};

/** ---- the scheduled + catch-up entry points ------------------------------- */

const lastTidyAt = async (mind: MindService): Promise<number> => {
  const events = await listRoutineEvents(mind.converse, { routineId: TIDY_ROUTINE_ID, limit: 50 });
  const last = events.find((event) => event.routineId === TIDY_ROUTINE_ID);
  return last?.at ?? 0;
};

/** Every owner label that has at least one profile row (the tidy's cron path). */
export const ownersWithProfiles = async (mind: MindService): Promise<string[]> => {
  const rows = await run(mind.converse.docs.snapshot(ProfilesDoc)).then(
    (doc) => doc?.profiles ?? [],
  );
  return [...new Set(rows.map((row) => row.owner).filter((owner) => owner !== ""))];
};

export const runTidy = async (
  deps: TidyDeps,
  owner: string,
): Promise<{ proposals: number; owner: string }> => {
  const { mind } = deps;
  await recordRoutineFire(mind.converse, {
    routineId: TIDY_ROUTINE_ID,
    source: "cron",
    reason: "memory tidy",
  });
  let total = 0;
  // The OWNER STORE is tidied too — profile stores alone were not enough.
  const stores: { owner: string; profileId: string | null }[] = [{ owner, profileId: null }];
  for (const profile of await mind.profiles.list(owner)) {
    if (profile.archivedAt === null) stores.push({ owner, profileId: profile.id });
  }
  for (const store of stores) {
    total += (await tidyStore(deps, store.owner, store.profileId)).created;
    await applyBackfill(deps, store.owner, store.profileId);
  }
  if (total > 0) {
    await deps.notify?.(owner, `Memory tidy: ${total} suggestions`);
  }
  return { proposals: total, owner };
};

/** Arm the croner timer; catch up on boot when the last run is 8+ days old. */
export const startMemoryTidy = (deps: TidyDeps): { readonly stop: () => void } => {
  const tidyAll = async (): Promise<void> => {
    for (const owner of await ownersWithProfiles(deps.mind)) {
      await runTidy(deps, owner).catch((cause) =>
        console.error(`memory tidy failed (${owner}):`, cause),
      );
    }
  };
  void (async () => {
    const last = await lastTidyAt(deps.mind).catch(() => 0);
    if (Date.now() - last > CATCH_UP_DAYS * 24 * 3_600_000) {
      await tidyAll().catch((cause) => console.error("memory tidy catch-up failed:", cause));
    }
  })();
  const timer = new Cron(tidyCron(), { timezone: "Asia/Jakarta" }, () => {
    void tidyAll().catch((cause) => console.error("memory tidy failed:", cause));
  });
  return { stop: () => timer.stop() };
};
