import {
  arr,
  bool,
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
 * Skills: packaged procedures a bot keeps in its own namespace. Metadata is
 * the store's index entry; bodies live as SKILL.md folders on disk. The
 * owner's Skills page reads the same shapes over REST.
 */

export const SkillOriginSchema = oneOf(["builtin", "self", "owner", "url"]);
export type SkillOrigin = Static<typeof SkillOriginSchema>;

export const SkillMetaSchema = obj(
  {
    name: str(),
    description: str(),
    origin: SkillOriginSchema,
    /** Where a url-origin skill came from; null otherwise. */
    sourceUrl: union([str(), nul()]),
    /** The profile whose craft this is (self-authored or evolved); null otherwise. */
    authorProfile: union([str(), nul()]),
    createdAt: num(),
    updatedAt: num(),
    version: num(),
    enabled: bool(),
    /** Paths beside SKILL.md (references, scripts), relative to the skill folder. */
    files: arr(str()),
    /** The version this one evolved from (or reverted to); null on plain writes. */
    parentVersion: union([num(), nul()]),
    evolutionNote: union([str(), nul()]),
    /** Skills this one absorbed (owner-accepted consolidation); kept on later saves. */
    absorbed: opt(arr(str())),
  },
  { open: true },
);
export type SkillMeta = Static<typeof SkillMetaSchema>;

/** An evolution (or owner-drafted) change parked for the owner's decision. */
export const SkillProposalSchema = obj(
  {
    id: str(),
    skill: str(),
    at: num(),
    /** The profile that proposed it; null for owner drafts. */
    byProfile: union([str(), nul()]),
    /** The skill version the proposal was drawn against. */
    baseVersion: num(),
    body: str(),
    note: str(),
    status: oneOf(["open", "accepted", "rejected"]),
    decidedAt: union([num(), nul()]),
    /**
     * The proposal's kind; absent on older rows, which read as "update" (a
     * new body for one skill). "absorb" merges sources into `skill`, the
     * kept skill, and removes the sources on accept.
     */
    kind: opt(oneOf(["update", "absorb"])),
    /** For kind "absorb": each source skill and the version drafted against. */
    absorbed: opt(arr(obj({ name: str(), version: num() }, { open: true }))),
  },
  { open: true },
);
export type SkillProposal = Static<typeof SkillProposalSchema>;

/** One stored skill's full text, with the proposals parked against it. */
export const SkillDetailSchema = obj(
  {
    meta: SkillMetaSchema,
    body: str(),
    proposals: arr(SkillProposalSchema),
  },
  { open: true },
);
export type SkillDetail = Static<typeof SkillDetailSchema>;

/** One profile's skill namespace, as the owner's Skills page reads it. */
export const SkillNamespaceSchema = obj(
  {
    profile: str(),
    profileName: str(),
    skills: arr(SkillMetaSchema),
  },
  { open: true },
);
export type SkillNamespace = Static<typeof SkillNamespaceSchema>;

/** The whole owner-scoped listing: the built-in library plus each profile's namespace. */
export const SkillOverviewSchema = obj(
  {
    builtins: arr(SkillMetaSchema),
    profiles: arr(SkillNamespaceSchema),
    openProposals: num(),
  },
  { open: true },
);
export type SkillOverview = Static<typeof SkillOverviewSchema>;
