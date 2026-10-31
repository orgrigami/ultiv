/**
 * Memory v2 data model: the doc families (one per tier), the fact
 * constructor, the hash that powers exact dedupe, the retention limits and
 * the environment flags. Storage stays pi-durable docs — no new database.
 * Rollback: `SPREISSEN_MEMORY_V2=off` sends every caller back to the v1 seam.
 */
import { createHash } from "node:crypto";
import { defineDocFamily } from "@earendil-works/pi-durable";
import { readEnv } from "@spreissen/core";
import type {
  CoreLine,
  MemoryEntity,
  MemoryEpisode,
  MemoryFact,
  MemoryProposal,
  MemoryRecord,
} from "@spreissen/contracts";

/**
 * The v1 store (`ultiv.memory`) — kept only for the `SPREISSEN_MEMORY_V2=off`
 * rollback surfaces. The mirror is gone (2026-10-28) and nothing migrates
 * into it; removing the doc family is a separate, owner-approved commit.
 */
export const MemoryDoc = defineDocFamily<{ records: MemoryRecord[] }, { records: MemoryRecord[] }>({
  kind: "ultiv.memory",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => seed,
  checkpointWhen: () => true,
});

export const ownerKey = (owner: string): string => `owner:${owner}`;
export const profileKey = (owner: string, profileId: string): string =>
  `profile:${owner}:${profileId}`;

/** The facts store: current, superseded and forgotten facts, with history. */
export const FactsDoc = defineDocFamily<
  { facts: MemoryFact[]; migratedAt: number | null },
  { facts: MemoryFact[]; migratedAt: number | null }
>({
  kind: "ultiv.mem.facts",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => seed,
  checkpointWhen: () => true,
});

/** Cold facts, still kept and searchable on demand. */
export const ArchiveDoc = defineDocFamily<{ facts: MemoryFact[] }, { facts: MemoryFact[] }>({
  kind: "ultiv.mem.archive",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => seed,
  checkpointWhen: () => true,
});

/** Resolved entities: people, pets, places, projects; edges ride the facts. */
export const GraphDoc = defineDocFamily<{ entities: MemoryEntity[] }, { entities: MemoryEntity[] }>(
  {
    kind: "ultiv.mem.graph",
    version: 1,
    scope: "session",
    family: true,
    initial: (seed) => seed,
    checkpointWhen: () => true,
  },
);

/** Where facts came from. A ring: past 1,000 lose text, keep ids + links. */
export const EpisodesDoc = defineDocFamily<
  { episodes: MemoryEpisode[] },
  { episodes: MemoryEpisode[] }
>({
  kind: "ultiv.mem.episodes",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => seed,
  checkpointWhen: () => true,
});

/** The always-on block, rendered as its own prompt section. */
export const CoreDoc = defineDocFamily<
  { lines: CoreLine[]; seededAt: number | null },
  { lines: CoreLine[]; seededAt: number | null }
>({
  kind: "ultiv.mem.core",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => seed,
  checkpointWhen: () => true,
});

/** Tidy suggestions. Nothing changes until the owner accepts. */
export const ProposalsDoc = defineDocFamily<
  { proposals: MemoryProposal[] },
  { proposals: MemoryProposal[] }
>({
  kind: "ultiv.mem.proposals",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => seed,
  checkpointWhen: () => true,
});

/** Retention limits (they replace v1's silent 2,000-note cap). */
export const LIMITS = {
  /** Soft: past this, tidy proposes archives. */
  softFacts: 3_000,
  /** Hard: past this, low-importance bot writes are refused. */
  hardFacts: 10_000,
  /** History above this: tidy proposes moving the oldest to the archive. */
  historySoft: 20_000,
  /** Episodes past this lose their text (ids and fact links stay). */
  episodesRing: 1_000,
  /** Open proposals cap; they expire after 30 days. */
  openProposals: 50,
  proposalTtlDays: 30,
  /** Text and tag caps. */
  textChars: 1_000,
  tags: 12,
} as const;

export const flags = {
  /** SPREISSEN_MEMORY_V2=off brings the v1 code path back, unchanged. */
  v2: (): boolean => readEnv("MEMORY_V2") !== "off",
  /** Model extraction; off = deterministic fallback only. */
  extract: (): boolean => process.env.MEMORY_EXTRACT !== "off",
  /** Embeddings are off by default; prefer a local Ollama model if ever on. */
  embeddings: (): boolean => process.env.MEMORY_EMBEDDINGS === "on",
  /** Weekly tidy schedule (croner, WIB). */
  tidyCron: (): string => process.env.MEMORY_TIDY_CRON ?? "0 9 * * 0",
};

/** sha1 of the normalized text — exact-duplicate detection. */
export const factHash = (text: string): string =>
  createHash("sha1").update(text.trim().toLowerCase()).digest("hex");

/** sha1 over the sorted id:hash pairs — the migration's integrity check. */
export const storeChecksum = (facts: readonly { id: string; hash: string }[]): string =>
  createHash("sha1")
    .update(
      facts
        .map((fact) => `${fact.id}:${fact.hash}`)
        .sort()
        .join("\n"),
    )
    .digest("hex");

export interface NewFactInput {
  readonly id: string;
  readonly scope: "profile" | "owner";
  readonly profile: string | null;
  readonly text: string;
  readonly kind: MemoryFact["kind"];
  readonly tags: readonly string[];
  readonly entities: readonly string[];
  readonly triple: MemoryFact["triple"];
  readonly importance: number;
  readonly confidence: number;
  readonly trust: MemoryFact["trust"];
  readonly source: MemoryFact["source"];
  readonly validFrom: number | null;
  readonly supersedes: readonly string[];
  readonly at: number;
}

/** One fact, fully stamped: every field explicit, no provider defaults. */
export const newFact = (input: NewFactInput): MemoryFact => ({
  id: input.id,
  scope: input.scope,
  profile: input.profile,
  text: input.text.slice(0, LIMITS.textChars),
  kind: input.kind,
  tags: [...input.tags].slice(0, LIMITS.tags),
  entities: [...input.entities],
  triple: input.triple,
  importance: Math.min(5, Math.max(1, Math.round(input.importance))),
  confidence: Math.min(1, Math.max(0, input.confidence)),
  trust: input.trust,
  source: input.source,
  validFrom: input.validFrom,
  validTo: null,
  createdAt: input.at,
  confirmedAt: input.at,
  expiredAt: null,
  status: "current",
  supersededBy: null,
  supersedes: [...input.supersedes],
  hash: factHash(input.text),
});

/** The v1 record shape a v2 fact projects to (REST compatibility only). */
export const mirrorRecord = (fact: MemoryFact): MemoryRecord => ({
  id: fact.id,
  scope: fact.scope,
  profile: fact.profile,
  text: fact.text,
  tags: fact.tags,
  at: fact.createdAt,
});
