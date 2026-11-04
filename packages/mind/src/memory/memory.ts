/**
 * The Memory seam (RFC 0001 §9): profile memory (an entity's own durable
 * facts) above owner memory (the user's cross-profile preferences). Write
 * authority is config, not goodwill: entities write about themselves; only
 * the owner-designated memory keeper (policies.memoryKeeper) writes owner
 * memory. Reads: an entity sees its own memory plus the owner store — never
 * a sibling's. Cross-thread recall resolves through here, never transcripts.
 *
 * v2 rides behind `SPRIESSEN_MEMORY_V2` (default on): writes land in
 * `ultiv.mem.facts`. The v1 mirror and the v1 migration are GONE (the soak
 * ended 2026-10-28 with nothing left to migrate); the v1 `ultiv.memory`
 * doc family and helpers stay exported for the rollback surfaces.
 */
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { InvalidInput, NotFound } from "@spriessen/core";
import type { FactTrust, MemoryEntity, MemoryFact, MemoryRecord } from "@spriessen/contracts";
import type { ConverseService } from "../converse/converse.ts";
import type { AuditService } from "../audit/audit.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import type { DecideService } from "../decide/decide.ts";
import type { GenerateService } from "../generate/generate.ts";
import { writeFactV2 } from "./consolidate.ts";
import { coreService } from "./core.ts";
import { forgetFact, historyOf, purgeForgotten, restoreFact } from "./forget.ts";
import { entitiesOf, relatedEntity } from "./graph.ts";
import {
  CoreDoc,
  EpisodesDoc,
  FactsDoc,
  GraphDoc,
  LIMITS,
  MemoryDoc,
  flags,
  mirrorRecord,
  newFact,
  ownerKey,
  profileKey,
} from "./model.ts";
import { shareOps } from "./share.ts";
import { recall, type RecallInput } from "./recall.ts";
import type { FactSearch } from "../search/facts.ts";
import { confirmFact, endFact } from "./lifecycle.ts";
import type { MemoryService } from "./memory-api.ts";
export type { MemoryService } from "./memory-api.ts";

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

export const memoryService = (deps: {
  readonly converse: ConverseService;
  readonly profiles: ProfilesService;
  /** The extraction/decision models; absent ⇒ deterministic fallbacks. */
  readonly generate?: GenerateService;
  readonly decide?: DecideService;
  /** The write guard's taint sources (audit trail + installed MCP tools). */
  readonly audit?: AuditService;
  readonly untrustedTool?: (name: string) => boolean;
  /** The search sidecar's facts index; absent ⇒ the in-process index. */
  readonly search?: FactSearch;
}): MemoryService => {
  const { converse, profiles } = deps;
  const lifecycleDeps = {
    converse,
    ...(deps.audit !== undefined ? { audit: deps.audit } : {}),
    ...(deps.untrustedTool !== undefined ? { untrustedTool: deps.untrustedTool } : {}),
  };

  const readStore = (key: string): Promise<MemoryRecord[]> =>
    run(converse.docs.snapshotKeyed(MemoryDoc, key)).then((store) => store?.records ?? []);

  const writeStore = (key: string, records: MemoryRecord[]): Promise<void> =>
    run(
      converse.docs.commit(async (tx) => {
        const draft = await tx.doc(MemoryDoc, key, { records: [] });
        draft.records = records;
      }),
    );

  const requireKeeper = async (owner: string, writer: string | null): Promise<void> => {
    // Only the designated keeper (or a human, writer null) writes owner memory.
    if (writer !== null) {
      const writerProfile = await profiles.get(owner, writer);
      if (writerProfile?.policies.memoryKeeper !== true) {
        throw new InvalidInput({
          reason: "only the designated memory keeper writes owner memory",
        });
      }
    }
  };

  /** The v2 add: one fact into `ultiv.mem.facts`. The v1 mirror is gone. */
  const addFactV2 = async (input: {
    readonly owner: string;
    readonly profileId: string | null;
    readonly scope: "profile" | "owner";
    readonly writer: string | null;
    readonly text: string;
    readonly tags?: readonly string[];
    /** Guard verdicts stamped onto the fact; defaults are the human/REST ones. */
    readonly trust?: FactTrust;
    readonly origin?: string;
    readonly conversation?: string | null;
  }): Promise<MemoryRecord> => {
    const key =
      input.profileId === null ? ownerKey(input.owner) : profileKey(input.owner, input.profileId);
    const fact = newFact({
      id: randomUUID(),
      scope: input.scope,
      profile: input.profileId,
      text: input.text.slice(0, LIMITS.textChars),
      kind: "note",
      tags: input.tags ?? [],
      entities: [],
      triple: null,
      importance: 3,
      confidence: 0.7,
      trust:
        input.trust ??
        (input.scope === "owner" ? "owner" : input.writer === null ? "owner" : "self"),
      source: {
        via: input.writer === null ? "rest" : "tool",
        writer: input.writer,
        origin: input.origin ?? "owner",
        conversation: input.conversation ?? null,
        episode: null,
      },
      validFrom: Date.now(),
      supersedes: [],
      at: Date.now(),
    });
    await run(
      converse.docs.commit(async (tx) => {
        const facts = await tx.doc(FactsDoc, key, { facts: [], migratedAt: null });
        facts.facts = [...facts.facts, fact];
      }),
    );
    return mirrorRecord(fact);
  };

  /**
   * The sidecar's full-text legs over a pool, after syncing each of its
   * stores. A sidecar that fails (disk, lock) falls back to the in-process
   * index: recall degrades, it never breaks.
   */
  const searchLegs = (
    read: readonly {
      key: string;
      facts: readonly MemoryFact[];
      entities: readonly MemoryEntity[];
    }[],
    entities: readonly MemoryEntity[],
  ): Pick<RecallInput, "search"> => {
    const search = deps.search;
    if (search === undefined) return {};
    const names = new Map(entities.map((entity) => [entity.id, [entity.name, ...entity.aliases]]));
    try {
      for (const store of read) search.sync(store.key, store.facts, (id) => names.get(id) ?? []);
    } catch (cause) {
      console.warn("memory search index unavailable, recalling in-process:", String(cause));
      return {};
    }
    const keys = read.map((store) => store.key);
    return {
      search: {
        lexical: (query, limit) => search.lexical(keys, query, limit),
        fuzzy: (query, limit) => search.fuzzy(keys, query, limit),
      },
    };
  };

  /** Remove a store's rows from the sidecar; the next recall rebuilds what is left. */
  const dropIndex = (key: string): void => {
    try {
      deps.search?.drop(key);
    } catch (cause) {
      console.warn("memory search index: could not drop a store:", String(cause));
    }
  };

  const service: MemoryService = {
    write: async (input) => {
      if (input.scope === "owner") {
        await requireKeeper(input.owner, input.writer);
        if (flags.v2()) {
          return addFactV2({
            ...input,
            profileId: null,
            ...(input.trust !== undefined ? { trust: input.trust } : {}),
            ...(input.origin !== undefined ? { origin: input.origin } : {}),
            ...(input.conversation !== undefined ? { conversation: input.conversation } : {}),
          });
        }
        const record: MemoryRecord = {
          id: randomUUID(),
          scope: input.scope,
          profile: null,
          text: input.text.slice(0, 4_000),
          tags: [...(input.tags ?? [])].slice(0, 12),
          at: Date.now(),
        };
        const records = await readStore(ownerKey(input.owner));
        await writeStore(ownerKey(input.owner), [...records, record].slice(-2_000));
        return record;
      }
      if (input.profileId === undefined) {
        throw new InvalidInput({ reason: "profileId is required for profile scope" });
      }
      const profileId: string = input.profileId;
      if (flags.v2()) {
        return addFactV2({
          owner: input.owner,
          writer: input.writer,
          scope: "profile",
          profileId,
          text: input.text,
          ...(input.tags !== undefined ? { tags: input.tags } : {}),
          ...(input.trust !== undefined ? { trust: input.trust } : {}),
          ...(input.origin !== undefined ? { origin: input.origin } : {}),
          ...(input.conversation !== undefined ? { conversation: input.conversation } : {}),
        });
      }
      const record: MemoryRecord = {
        id: randomUUID(),
        scope: "profile",
        profile: input.profileId,
        text: input.text.slice(0, 4_000),
        tags: [...(input.tags ?? [])].slice(0, 12),
        at: Date.now(),
      };
      const key = profileKey(input.owner, input.profileId);
      const records = await readStore(key);
      await writeStore(key, [...records, record].slice(-2_000));
      return record;
    },
    recallFor: async (owner, profileId, query) => {
      if (flags.v2()) {
        const ranked = await service.recallV2(
          owner,
          profileId,
          query !== undefined ? { query } : {},
        );
        return ranked.facts.map((fact) => ({
          id: fact.id,
          scope: fact.scope,
          profile: fact.profile,
          text: fact.text,
          tags: fact.tags,
          at: fact.createdAt,
        }));
      }
      const [own, ownerStore] = await Promise.all([
        readStore(profileKey(owner, profileId)),
        readStore(ownerKey(owner)),
      ]);
      const all = [...own, ...ownerStore];
      if (query === undefined || query.trim() === "") return all.slice(-100).reverse();
      const needle = query.trim().toLowerCase();
      return all
        .filter(
          (record) =>
            record.text.toLowerCase().includes(needle) ||
            record.tags.some((tag) => tag.toLowerCase().includes(needle)),
        )
        .slice(-100)
        .reverse();
    },
    read: (owner, scope, profileId) => {
      if (flags.v2()) {
        // REST compatibility: the old endpoints project the v2 store. A
        // profile scope without a profile id reads NOTHING — never an
        // empty-keyed store.
        if (scope === "profile" && (profileId === undefined || profileId === "")) {
          return Promise.resolve([]);
        }
        return service
          .readFacts(owner, scope === "owner" ? null : (profileId ?? ""))
          .then((facts) =>
            facts
              .filter((fact) => fact.status !== "forgotten")
              .slice(-500)
              .reverse()
              .map((fact) => ({
                id: fact.id,
                scope: fact.scope,
                profile: fact.profile,
                text: fact.text,
                tags: fact.tags,
                at: fact.createdAt,
              })),
          );
      }
      return scope === "owner"
        ? readStore(ownerKey(owner)).then((records) => records.slice(-500).reverse())
        : profileId !== undefined
          ? readStore(profileKey(owner, profileId)).then((records) => records.slice(-500).reverse())
          : Promise.resolve([]);
    },
    removeProfile: async (owner, profileId) => {
      // Count BEFORE clearing (the tx below empties both stores).
      const v2Count = (await service.readFacts(owner, profileId)).length;
      await writeStore(profileKey(owner, profileId), []);
      // v2 tiers clear with the store (purge cascade); the v1 doc too.
      await run(
        converse.docs.commit(async (tx) => {
          const facts = await tx.doc(FactsDoc, profileKey(owner, profileId), {
            facts: [],
            migratedAt: null,
          });
          facts.facts = [];
          facts.migratedAt = null;
          const graph = await tx.doc(GraphDoc, profileKey(owner, profileId), { entities: [] });
          graph.entities = [];
          const episodes = await tx.doc(EpisodesDoc, profileKey(owner, profileId), {
            episodes: [],
          });
          episodes.episodes = [];
          const core = await tx.doc(CoreDoc, profileKey(owner, profileId), {
            lines: [],
            seededAt: null,
          });
          core.lines = [];
        }),
      );
      dropIndex(profileKey(owner, profileId));
      return v2Count;
    },
    remove: async (owner, profileId, recordId) => {
      if (flags.v2()) {
        await service.tombstone(owner, profileId, recordId);
        return;
      }
      const key = profileKey(owner, profileId);
      const records = await readStore(key);
      const next = records.filter((record) => record.id !== recordId);
      if (next.length === records.length) {
        throw new NotFound({ what: `memory record ${recordId}` });
      }
      await writeStore(key, next);
    },
    readFacts: async (owner, profileId) => {
      const key = profileId === null ? ownerKey(owner) : profileKey(owner, profileId);
      return run(converse.docs.snapshotKeyed(FactsDoc, key)).then((store) => store?.facts ?? []);
    },
    recallV2: async (owner, profileId, opts = {}) => {
      // An entity recalls its own store plus the owner store — never a
      // sibling's. ONE ranking over the combined pool, so the limit and the
      // token budget hold across the merge and owner facts compete on score
      // instead of being appended after the profile's (they crowded out).
      // A department bot's shared store joins the pool through extraStores.
      const stores = [profileKey(owner, profileId), ownerKey(owner), ...(opts.extraStores ?? [])];
      const read = await Promise.all(
        stores.map(async (key) => ({
          key,
          facts: await run(converse.docs.snapshotKeyed(FactsDoc, key)).then(
            (store) => store?.facts ?? [],
          ),
          entities: await run(converse.docs.snapshotKeyed(GraphDoc, key)).then(
            (store) => store?.entities ?? [],
          ),
        })),
      );
      const entities = read.flatMap((store) => store.entities);
      const legs = searchLegs(read, entities);
      const semantic =
        legs.search !== undefined && deps.search?.semantic !== undefined && opts.query !== undefined
          ? await deps.search.semantic(stores, opts.query, 20).catch((cause: unknown) => {
              console.warn("memory meaning search unavailable:", String(cause).slice(0, 200));
              return [];
            })
          : undefined;
      const result = recall({
        facts: read.flatMap((store) => store.facts),
        entities,
        cacheKey: stores.join("|"),
        ...legs,
        ...(semantic !== undefined ? { semantic } : {}),
        ...(opts.query !== undefined ? { query: opts.query } : {}),
        ...(opts.includeHistory !== undefined ? { includeHistory: opts.includeHistory } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts.budgetTokens !== undefined ? { budgetTokens: opts.budgetTokens } : {}),
        ...(opts.asOf !== undefined ? { asOf: opts.asOf } : {}),
      });
      return { core: [], facts: result.facts, lines: result.lines, tokens: result.tokens };
    },
    writeV2: async (input) => {
      if (input.scope === "owner") await requireKeeper(input.owner, input.writer);
      return writeFactV2(deps, input);
    },
    core: coreService({ converse, profiles }),
    forget: (owner, profileId, factId, reason, conversationId) =>
      forgetFact(
        {
          converse,
          profiles,
          guard: {
            ...(deps.audit !== undefined ? { audit: deps.audit } : {}),
            ...(deps.untrustedTool !== undefined ? { untrustedTool: deps.untrustedTool } : {}),
          },
        },
        owner,
        profileId,
        factId,
        reason,
        conversationId,
      ),
    history: (owner, profileId, factId) => historyOf({ converse }, owner, profileId, factId),
    end: (owner, profileId, ref, at, conversationId) =>
      endFact(lifecycleDeps, owner, profileId, ref, at, conversationId),
    confirm: (owner, profileId, ref, conversationId) =>
      confirmFact(lifecycleDeps, owner, profileId, ref, conversationId),
    restore: (owner, profileId, factId) => restoreFact({ converse }, owner, profileId, factId),
    purge: async (owner, profileId) => {
      const purged = await purgeForgotten({ converse }, owner, profileId);
      // Purged text must leave the sidecar now, not at the store's next recall.
      dropIndex(profileId === null ? ownerKey(owner) : profileKey(owner, profileId));
      return purged;
    },
    entities: (owner, profileId) => entitiesOf({ converse }, owner, profileId),
    related: (owner, profileId, entity, depth) =>
      relatedEntity({ converse }, owner, profileId, entity, depth ?? 1),
    tombstone: async (owner, profileId, factId) => {
      const key = profileId === null ? ownerKey(owner) : profileKey(owner, profileId);
      await run(
        converse.docs.commit(async (tx) => {
          const facts = await tx.doc(FactsDoc, key, { facts: [], migratedAt: null });
          facts.facts = facts.facts.map((fact) =>
            fact.id === factId && fact.status !== "forgotten"
              ? { ...fact, status: "forgotten" as const, expiredAt: Date.now() }
              : fact,
          );
        }),
      );
    },
    // Shared department memory (slice 9): propose, read, decide.
    ...shareOps(converse),
  };
  return service;
};

export { MemoryDoc, ownerKey as memoryOwnerKey, profileKey as memoryProfileKey } from "./model.ts";
