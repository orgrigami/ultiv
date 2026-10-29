import { Type, type Static } from "typebox";

/**
 * Skills: packaged procedures a bot keeps in its own namespace. Metadata is
 * the store's index entry; bodies live as SKILL.md folders on disk. The
 * owner's Skills page reads the same shapes over REST.
 */

export const SkillOriginSchema = Type.Union([
  Type.Literal("builtin"),
  Type.Literal("self"),
  Type.Literal("owner"),
  Type.Literal("url"),
]);
export type SkillOrigin = Static<typeof SkillOriginSchema>;

export const SkillMetaSchema = Type.Object({
  name: Type.String(),
  description: Type.String(),
  origin: SkillOriginSchema,
  /** Where a url-origin skill came from; null otherwise. */
  sourceUrl: Type.Union([Type.String(), Type.Null()]),
  /** The profile whose craft this is (self-authored or evolved); null otherwise. */
  authorProfile: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  version: Type.Number(),
  enabled: Type.Boolean(),
  /** Paths beside SKILL.md (references, scripts), relative to the skill folder. */
  files: Type.Array(Type.String()),
  /** The version this one evolved from (or reverted to); null on plain writes. */
  parentVersion: Type.Union([Type.Number(), Type.Null()]),
  evolutionNote: Type.Union([Type.String(), Type.Null()]),
});
export type SkillMeta = Static<typeof SkillMetaSchema>;

/** An evolution (or owner-drafted) change parked for the owner's decision. */
export const SkillProposalSchema = Type.Object({
  id: Type.String(),
  skill: Type.String(),
  at: Type.Number(),
  /** The profile that proposed it; null for owner drafts. */
  byProfile: Type.Union([Type.String(), Type.Null()]),
  /** The skill version the proposal was drawn against. */
  baseVersion: Type.Number(),
  body: Type.String(),
  note: Type.String(),
  status: Type.Union([Type.Literal("open"), Type.Literal("accepted"), Type.Literal("rejected")]),
  decidedAt: Type.Union([Type.Number(), Type.Null()]),
});
export type SkillProposal = Static<typeof SkillProposalSchema>;

/** One stored skill's full text, with the proposals parked against it. */
export const SkillDetailSchema = Type.Object({
  meta: SkillMetaSchema,
  body: Type.String(),
  proposals: Type.Array(SkillProposalSchema),
});
export type SkillDetail = Static<typeof SkillDetailSchema>;

/** One profile's skill namespace, as the owner's Skills page reads it. */
export const SkillNamespaceSchema = Type.Object({
  profile: Type.String(),
  profileName: Type.String(),
  skills: Type.Array(SkillMetaSchema),
});
export type SkillNamespace = Static<typeof SkillNamespaceSchema>;

/** The whole owner-scoped listing: the built-in library plus each profile's namespace. */
export const SkillOverviewSchema = Type.Object({
  builtins: Type.Array(SkillMetaSchema),
  profiles: Type.Array(SkillNamespaceSchema),
  openProposals: Type.Number(),
});
export type SkillOverview = Static<typeof SkillOverviewSchema>;
