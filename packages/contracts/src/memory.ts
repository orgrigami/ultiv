import { Type, type Static } from "typebox";

/**
 * One memory record. Scope `profile` = one entity's own durable facts (keyed
 * by profile id); scope `owner` = the user's cross-profile store (preferences
 * that must not be re-taught per entity). Write authority is config: entities
 * write about themselves; only the owner-designated memory keeper writes
 * owner memory. This is the v1 record — kept for the rollback mirror and the
 * REST surfaces; the v2 fact (MemoryFactSchema) supersedes it.
 */
export const MemoryRecordSchema = Type.Object({
  id: Type.String(),
  scope: Type.Union([
    Type.Literal("profile"),
    Type.Literal("owner"),
    /** Lives in a team's shared store (accepted from a share proposal). */
    Type.Literal("team"),
  ]),
  /** The profile a profile-scope record belongs to; null for owner scope. */
  profile: Type.Union([Type.String(), Type.Null()]),
  text: Type.String(),
  tags: Type.Array(Type.String()),
  at: Type.Number(),
});

export type MemoryRecord = Static<typeof MemoryRecordSchema>;

export const MemoryListSchema = Type.Array(MemoryRecordSchema);

export type MemoryList = Static<typeof MemoryListSchema>;

/** The lifecycle of a v2 fact. Nothing is ever deleted but a Purge. */
export const FactStatusSchema = Type.Union([
  Type.Literal("current"),
  Type.Literal("superseded"),
  Type.Literal("archived"),
  Type.Literal("forgotten"),
]);
export type FactStatus = Static<typeof FactStatusSchema>;

export const FactKindSchema = Type.Union([
  Type.Literal("fact"),
  Type.Literal("preference"),
  Type.Literal("instruction"),
  Type.Literal("event"),
  Type.Literal("note"),
]);
export type FactKind = Static<typeof FactKindSchema>;

/** Who vouches for a fact. Untrusted facts never steer behaviour. */
export const FactTrustSchema = Type.Union([
  Type.Literal("owner"),
  Type.Literal("self"),
  Type.Literal("derived"),
  Type.Literal("untrusted"),
]);
export type FactTrust = Static<typeof FactTrustSchema>;

/** How the writer knows a fact. */
export const FactBasisSchema = Type.Union([
  Type.Literal("owner_said"),
  Type.Literal("observed"),
  Type.Literal("inferred"),
  Type.Literal("confirmed"),
]);
export type FactBasis = Static<typeof FactBasisSchema>;

/** Why a version left the present (see MemoryFactSchema.retired). */
export const FactRetiredSchema = Type.Union([
  Type.Literal("changed"),
  Type.Literal("corrected"),
  Type.Literal("ended"),
]);
export type FactRetired = Static<typeof FactRetiredSchema>;

/** Where a fact came from. Every write is stamped. */
export const FactSourceSchema = Type.Object({
  /** The surface that produced it: tool, rest, tidy, migration. */
  via: Type.String(),
  /** The writing profile id; null = a human/REST write. */
  writer: Type.Union([Type.String(), Type.Null()]),
  /** The input's origin class: owner, cron, webhook, sensor, bot, unknown. */
  origin: Type.String(),
  /** The conversation the fact was mined from. */
  conversation: Type.Union([Type.String(), Type.Null()]),
  /** The episode that carries the raw input. */
  episode: Type.Union([Type.String(), Type.Null()]),
});
export type FactSource = Static<typeof FactSourceSchema>;

/** A (subject, predicate, object) graph edge carried by the fact itself. */
export const FactTripleSchema = Type.Object({
  s: Type.String(),
  p: Type.String(),
  o: Type.String(),
});
export type FactTriple = Static<typeof FactTripleSchema>;

/**
 * One v2 fact: the unit of memory. Dated twice (world-time validity and
 * system-time bookkeeping), sourced, ranked (importance/confidence/trust),
 * linked (entities, triple, supersede chain) and hash-deduplicated.
 */
export const MemoryFactSchema = Type.Object({
  id: Type.String(),
  scope: Type.Union([
    Type.Literal("profile"),
    Type.Literal("owner"),
    /** Lives in a team's shared store (accepted from a share proposal). */
    Type.Literal("team"),
  ]),
  profile: Type.Union([Type.String(), Type.Null()]),
  /** Stored in the language it was said in; never translated. */
  text: Type.String({ maxLength: 1_000 }),
  kind: FactKindSchema,
  tags: Type.Array(Type.String()),
  /** Entity ids this fact is about. */
  entities: Type.Array(Type.String()),
  triple: Type.Union([FactTripleSchema, Type.Null()]),
  importance: Type.Number({ minimum: 1, maximum: 5 }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  trust: FactTrustSchema,
  source: FactSourceSchema,
  /** World-time validity interval (WIB epoch ms). */
  validFrom: Type.Union([Type.Number(), Type.Null()]),
  validTo: Type.Union([Type.Number(), Type.Null()]),
  createdAt: Type.Number(),
  confirmedAt: Type.Number(),
  expiredAt: Type.Union([Type.Number(), Type.Null()]),
  status: FactStatusSchema,
  supersededBy: Type.Union([Type.String(), Type.Null()]),
  supersedes: Type.Array(Type.String()),
  /** sha1 of normalized text — exact-duplicate detection. */
  hash: Type.String(),
  /**
   * How the writer knows it: the owner said it, the bot observed it, the bot
   * inferred it, or an inference the owner since confirmed. Absent on facts
   * written before v3. Recall marks unconfirmed inferences.
   */
  basis: Type.Optional(FactBasisSchema),
  /**
   * Why a version left the present: `changed` (it stopped being true and a
   * newer version holds), `corrected` (it was wrong — never shown as the
   * past), `ended` (it stopped holding, nothing replaces it). Absent while
   * current and on versions retired before v3.
   */
  retired: Type.Optional(FactRetiredSchema),
  /** Times the owner confirmed this fact (said it again or agreed). */
  confirmations: Type.Optional(Type.Number({ minimum: 0 })),
});
export type MemoryFact = Static<typeof MemoryFactSchema>;

/**
 * A resolved entity: person, pet, place, project… `owner` and a per-bot
 * `self` are reserved ids. Aliases fold recall ("si oren" → §e:<id>).
 */
export const MemoryEntitySchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  type: Type.Union([
    Type.Literal("person"),
    Type.Literal("pet"),
    Type.Literal("place"),
    Type.Literal("org"),
    Type.Literal("project"),
    Type.Literal("thing"),
    Type.Literal("concept"),
    Type.Literal("event"),
    Type.Literal("self"),
  ]),
  aliases: Type.Array(Type.String(), { maxItems: 12 }),
  summary: Type.String(),
  createdAt: Type.Number(),
  /** Set when this entity was merged into another; the id stays a redirect. */
  mergedInto: Type.Union([Type.String(), Type.Null()]),
});
export type MemoryEntity = Static<typeof MemoryEntitySchema>;

/** Where facts come from: the raw input that produced them. Never prompted. */
export const MemoryEpisodeSchema = Type.Object({
  id: Type.String(),
  at: Type.Number(),
  origin: Type.String(),
  conversation: Type.Union([Type.String(), Type.Null()]),
  /** Cleared past the 1,000 ring (ids and fact links stay). */
  input: Type.String(),
  facts: Type.Array(Type.String()),
});
export type MemoryEpisode = Static<typeof MemoryEpisodeSchema>;

/** One always-on core line. Bots cannot edit lines the owner pinned. */
export const CoreLineSchema = Type.Object({
  id: Type.String(),
  text: Type.String(),
  /** The fact this line distills; supersede updates the line in place. */
  factId: Type.Union([Type.String(), Type.Null()]),
  pinned: Type.Boolean(),
  at: Type.Number(),
});
export type CoreLine = Static<typeof CoreLineSchema>;

/** One tidy suggestion. Nothing changes until the owner accepts. */
export const MemoryProposalSchema = Type.Object({
  id: Type.String(),
  kind: Type.Union([
    Type.Literal("merge"),
    Type.Literal("conflict"),
    Type.Literal("stale"),
    Type.Literal("entity-merge"),
    Type.Literal("secret"),
    Type.Literal("core-fix"),
    Type.Literal("archive"),
    Type.Literal("backfill"),
    /** A bot proposes one of its own facts for the team store. */
    Type.Literal("share"),
  ]),
  at: Type.Number(),
  factIds: Type.Array(Type.String()),
  /** Human-readable suggestion; no secret bytes, ever. */
  summary: Type.String(),
  /** Rejected fingerprints never come back. */
  fingerprint: Type.String(),
  status: Type.Union([Type.Literal("open"), Type.Literal("accepted"), Type.Literal("rejected")]),
  decidedAt: Type.Union([Type.Number(), Type.Null()]),
});
export type MemoryProposal = Static<typeof MemoryProposalSchema>;
