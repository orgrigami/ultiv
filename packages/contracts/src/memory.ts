import {
  arr,
  bool,
  lit,
  nul,
  num,
  obj,
  oneOf,
  opt,
  str,
  union,
  type Static,
} from "@earendil-works/pi-schema";

/**
 * One memory record. Scope `profile` = one entity's own durable facts (keyed
 * by profile id); scope `owner` = the user's cross-profile store (preferences
 * that must not be re-taught per entity). Write authority is config: entities
 * write about themselves; only the owner-designated memory keeper writes
 * owner memory. This is the v1 record — kept for the rollback mirror and the
 * REST surfaces; the v2 fact (MemoryFactSchema) supersedes it.
 */
export const MemoryRecordSchema = obj(
  {
    id: str(),
    scope: union([
      lit("profile"),
      lit("owner"),
      /** Lives in a team's shared store (accepted from a share proposal). */
      lit("team"),
    ]),
    /** The profile a profile-scope record belongs to; null for owner scope. */
    profile: union([str(), nul()]),
    text: str(),
    tags: arr(str()),
    at: num(),
  },
  { open: true },
);

export type MemoryRecord = Static<typeof MemoryRecordSchema>;

export const MemoryListSchema = arr(MemoryRecordSchema);

export type MemoryList = Static<typeof MemoryListSchema>;

/** The lifecycle of a v2 fact. Nothing is ever deleted but a Purge. */
export const FactStatusSchema = oneOf(["current", "superseded", "archived", "forgotten"]);
export type FactStatus = Static<typeof FactStatusSchema>;

export const FactKindSchema = oneOf(["fact", "preference", "instruction", "event", "note"]);
export type FactKind = Static<typeof FactKindSchema>;

/** Who vouches for a fact. Untrusted facts never steer behaviour. */
export const FactTrustSchema = oneOf(["owner", "self", "derived", "untrusted"]);
export type FactTrust = Static<typeof FactTrustSchema>;

/** How the writer knows a fact. */
export const FactBasisSchema = oneOf(["owner_said", "observed", "inferred", "confirmed"]);
export type FactBasis = Static<typeof FactBasisSchema>;

/** Why a version left the present (see MemoryFactSchema.retired). */
export const FactRetiredSchema = oneOf(["changed", "corrected", "ended"]);
export type FactRetired = Static<typeof FactRetiredSchema>;

/** Where a fact came from. Every write is stamped. */
export const FactSourceSchema = obj(
  {
    /** The surface that produced it: tool, rest, tidy, migration. */
    via: str(),
    /** The writing profile id; null = a human/REST write. */
    writer: union([str(), nul()]),
    /** The input's origin class: owner, cron, webhook, sensor, bot, unknown. */
    origin: str(),
    /** The conversation the fact was mined from. */
    conversation: union([str(), nul()]),
    /** The episode that carries the raw input. */
    episode: union([str(), nul()]),
  },
  { open: true },
);
export type FactSource = Static<typeof FactSourceSchema>;

/** A (subject, predicate, object) graph edge carried by the fact itself. */
export const FactTripleSchema = obj(
  {
    s: str(),
    p: str(),
    o: str(),
  },
  { open: true },
);
export type FactTriple = Static<typeof FactTripleSchema>;

/**
 * One v2 fact: the unit of memory. Dated twice (world-time validity and
 * system-time bookkeeping), sourced, ranked (importance/confidence/trust),
 * linked (entities, triple, supersede chain) and hash-deduplicated.
 */
export const MemoryFactSchema = obj(
  {
    id: str(),
    scope: union([
      lit("profile"),
      lit("owner"),
      /** Lives in a team's shared store (accepted from a share proposal). */
      lit("team"),
    ]),
    profile: union([str(), nul()]),
    /** Stored in the language it was said in; never translated. */
    text: str({ maxLength: 1_000 }),
    kind: FactKindSchema,
    tags: arr(str()),
    /** Entity ids this fact is about. */
    entities: arr(str()),
    triple: union([FactTripleSchema, nul()]),
    importance: num({ minimum: 1, maximum: 5 }),
    confidence: num({ minimum: 0, maximum: 1 }),
    trust: FactTrustSchema,
    source: FactSourceSchema,
    /** World-time validity interval (WIB epoch ms). */
    validFrom: union([num(), nul()]),
    validTo: union([num(), nul()]),
    createdAt: num(),
    confirmedAt: num(),
    expiredAt: union([num(), nul()]),
    status: FactStatusSchema,
    supersededBy: union([str(), nul()]),
    supersedes: arr(str()),
    /** sha1 of normalized text — exact-duplicate detection. */
    hash: str(),
    /**
     * How the writer knows it: the owner said it, the bot observed it, the bot
     * inferred it, or an inference the owner since confirmed. Absent on facts
     * written before v3. Recall marks unconfirmed inferences.
     */
    basis: opt(FactBasisSchema),
    /**
     * Why a version left the present: `changed` (it stopped being true and a
     * newer version holds), `corrected` (it was wrong — never shown as the
     * past), `ended` (it stopped holding, nothing replaces it). Absent while
     * current and on versions retired before v3.
     */
    retired: opt(FactRetiredSchema),
    /** Times the owner confirmed this fact (said it again or agreed). */
    confirmations: opt(num({ minimum: 0 })),
  },
  { open: true },
);
export type MemoryFact = Static<typeof MemoryFactSchema>;

/**
 * A resolved entity: person, pet, place, project… `owner` and a per-bot
 * `self` are reserved ids. Aliases fold recall ("si oren" → §e:<id>).
 */
export const MemoryEntitySchema = obj(
  {
    id: str(),
    name: str(),
    type: oneOf(["person", "pet", "place", "org", "project", "thing", "concept", "event", "self"]),
    aliases: arr(str(), { maxItems: 12 }),
    summary: str(),
    createdAt: num(),
    /** Set when this entity was merged into another; the id stays a redirect. */
    mergedInto: union([str(), nul()]),
  },
  { open: true },
);
export type MemoryEntity = Static<typeof MemoryEntitySchema>;

/** Where facts come from: the raw input that produced them. Never prompted. */
export const MemoryEpisodeSchema = obj(
  {
    id: str(),
    at: num(),
    origin: str(),
    conversation: union([str(), nul()]),
    /** Cleared past the 1,000 ring (ids and fact links stay). */
    input: str(),
    facts: arr(str()),
  },
  { open: true },
);
export type MemoryEpisode = Static<typeof MemoryEpisodeSchema>;

/** One always-on core line. Bots cannot edit lines the owner pinned. */
export const CoreLineSchema = obj(
  {
    id: str(),
    text: str(),
    /** The fact this line distills; supersede updates the line in place. */
    factId: union([str(), nul()]),
    pinned: bool(),
    at: num(),
  },
  { open: true },
);
export type CoreLine = Static<typeof CoreLineSchema>;

/** One tidy suggestion. Nothing changes until the owner accepts. */
export const MemoryProposalSchema = obj(
  {
    id: str(),
    kind: union([
      lit("merge"),
      lit("conflict"),
      lit("stale"),
      lit("entity-merge"),
      lit("secret"),
      lit("core-fix"),
      lit("archive"),
      lit("backfill"),
      /** A bot proposes one of its own facts for the team store. */
      lit("share"),
    ]),
    at: num(),
    factIds: arr(str()),
    /** Human-readable suggestion; no secret bytes, ever. */
    summary: str(),
    /** Rejected fingerprints never come back. */
    fingerprint: str(),
    status: oneOf(["open", "accepted", "rejected"]),
    decidedAt: union([num(), nul()]),
  },
  { open: true },
);
export type MemoryProposal = Static<typeof MemoryProposalSchema>;
