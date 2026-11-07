/**
 * The memory faculty's surface (MemoryService): what the tools, the REST
 * routes and the tidy call. memory.ts builds it.
 */

import type {
  FactKind,
  FactTrust,
  MemoryEntity,
  MemoryFact,
  MemoryProposal,
  MemoryRecord,
} from "@spriessen/contracts";
import type { WriteFactResult } from "./consolidate.ts";
import type { CoreService } from "./core.ts";
import type { ForgetResult, HistoryEntry } from "./forget.ts";
import type { EntityCard } from "./graph.ts";
import type { RecallResult } from "./recall.ts";

export interface MemoryService {
  /** Append one record. Scope `owner` requires the writer to be the keeper. */
  readonly write: (input: {
    readonly owner: string;
    /** The writing profile; null = a human/REST write (always allowed). */
    readonly writer: string | null;
    readonly scope: "profile" | "owner";
    /** Target profile for profile scope. */
    readonly profileId?: string;
    readonly text: string;
    readonly tags?: readonly string[];
    /** Guard verdicts (write guard §3). Absent = human/REST: trust owner. */
    readonly trust?: FactTrust;
    readonly origin?: string;
    readonly conversation?: string | null;
  }) => Promise<MemoryRecord>;
  /** An entity's readable world: its own memory plus the owner store. */
  readonly recallFor: (owner: string, profileId: string, query?: string) => Promise<MemoryRecord[]>;
  /** Read one scope outright (REST surfaces). */
  readonly read: (
    owner: string,
    scope: "profile" | "owner",
    profileId?: string,
  ) => Promise<MemoryRecord[]>;
  readonly removeProfile: (owner: string, profileId: string) => Promise<number>;
  /** Remove one profile-scope record — the human's per-item delete. */
  readonly remove: (owner: string, profileId: string, recordId: string) => Promise<void>;
  /**
   * v2: read a store's facts. There is no v1 migration anymore (the soak
   * ended 2026-10-28 with nothing left to migrate) — reads are v2-only.
   */
  readonly readFacts: (owner: string, profileId: string | null) => Promise<readonly MemoryFact[]>;
  /**
   * v2 ranked recall over own + owner facts (never a sibling's). Empty query
   * returns the top facts by importance × recency; history stays behind
   * `includeHistory`.
   */
  readonly recallV2: (
    owner: string,
    profileId: string,
    opts?: {
      readonly query?: string;
      readonly includeHistory?: boolean;
      readonly limit?: number;
      readonly budgetTokens?: number;
      /** Additional store keys in the pool (a team's shared store). */
      readonly extraStores?: readonly string[];
      /** What held at this moment (a past day): versions valid then, current or not. */
      readonly asOf?: number;
    },
  ) => Promise<RecallResult>;
  /**
   * A team bot proposes one of its own profile facts for the
   * team's shared store (slice 9). Nothing is shared until a
   * team admin accepts; rejection discards the proposal.
   */
  readonly proposeShare: (input: {
    readonly owner: string;
    readonly profileId: string;
    readonly teamId: string;
    readonly factId: string;
    readonly summary: string;
  }) => Promise<MemoryProposal>;
  /** A team store's facts (the shared view its admins read). */
  readonly teamFacts: (owner: string, teamId: string) => Promise<readonly MemoryFact[]>;
  /** Accept or reject a share proposal; ONLY a team admin may (REST checks). */
  readonly decideShare: (input: {
    readonly owner: string;
    readonly teamId: string;
    readonly proposalId: string;
    readonly accept: boolean;
  }) => Promise<"accepted" | "rejected" | "unknown">;
  /**
   * v2 consolidating write: extract → resolve → decide → apply in one
   * transaction (supersede/refine keep history). The tool surface; `write`
   * above stays the plain append for REST/v1.
   */
  readonly writeV2: (input: {
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
    readonly validTo?: number | null;
    readonly correction?: boolean;
    readonly trust?: FactTrust;
    readonly origin?: string;
    readonly conversation?: string | null;
  }) => Promise<WriteFactResult>;
  /** The always-on core block: read/add/replace/remove with budgets. */
  readonly core: CoreService;
  /** Tombstone a fact (restorable; text survives until the owner purges). */
  readonly forget: (
    owner: string,
    profileId: string,
    factId: string,
    reason: string,
    conversationId: string | null,
  ) => Promise<ForgetResult>;
  /** One fact's version chain with validity, change type and source. */
  readonly history: (
    owner: string,
    profileId: string | null,
    factId: string,
  ) => Promise<readonly HistoryEntry[]>;
  /** A fact stops holding from `at` (default now); see lifecycle.ts. */
  readonly end: (
    owner: string,
    profileId: string | null,
    ref: string,
    at: number | undefined,
    conversationId: string | null,
  ) => Promise<{ readonly id: string; readonly endsAt: number; readonly retired: boolean }>;
  /** The owner confirmed a fact; only a clean owner turn may. */
  readonly confirm: (
    owner: string,
    profileId: string | null,
    ref: string,
    conversationId: string | null,
  ) => Promise<{ readonly id: string; readonly confirmations: number }>;
  /** The owner's undo of a tombstone. */
  readonly restore: (owner: string, profileId: string | null, factId: string) => Promise<void>;
  /** The owner's irreversible purge of forgotten facts' text. */
  readonly purge: (owner: string, profileId: string | null) => Promise<number>;
  /** The owner's unconditional tombstone (REST surface on any store). */
  readonly tombstone: (owner: string, profileId: string | null, factId: string) => Promise<void>;
  /** The store's resolved entities. */
  readonly entities: (owner: string, profileId: string | null) => Promise<readonly MemoryEntity[]>;
  /** The entity card: current facts plus the neighbourhood (1–2 hops). */
  readonly related: (
    owner: string,
    profileId: string | null,
    entity: string,
    depth?: 1 | 2,
  ) => Promise<EntityCard>;
}
