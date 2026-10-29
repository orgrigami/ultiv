import { Type, type Static } from "typebox";

/** A profile's starting model/effort for new chats; null = the mind's default. */
export const ProfileModelSchema = Type.Object({
  id: Type.String(),
  effort: Type.String(),
});

export type ProfileModel = Static<typeof ProfileModelSchema>;

/** How gated tool calls get approved for this profile: the owner each time ('manual'), Jev as the gate ('jev'), or nobody ('yolo'). */
export const ProfileApprovalModeSchema = Type.Union([
  Type.Literal("manual"),
  Type.Literal("jev"),
  Type.Literal("yolo"),
]);

export type ProfileApprovalMode = Static<typeof ProfileApprovalModeSchema>;

/** Behavior policy of one profile: initiation rights, approvals, budget. */
export const ProfilePoliciesSchema = Type.Object({
  /** Sibling ids this entity may message autonomously; ["*"] (default) = all, [] = locked. */
  canInitiate: Type.Array(Type.String()),
  /**
   * Gated tools pre-approved for this profile. An entry is a bare tool name
   * ("bash" approves every bash call — the owner's whole-tool grant) or a
   * `tool:pattern` sub-action rule ("bash:git *"): an anchored glob over the
   * call's command/action text (`*` any run, `?` one char — wildcards cannot
   * cross a `;`/`&&`/`|` boundary; else literal, case-sensitive). A pattern
   * match that looks destructive is refused to the normal gate, and
   * `bash_host` never pattern-matches. Floors (first-use
   * credential/connector, `secret_request`) outrank every entry.
   */
  autoApprove: Type.Array(Type.String()),
  /** Who answers a gated call: the owner each time, Jev as the gate, or nobody. */
  approvalMode: ProfileApprovalModeSchema,
  /** What a pending approval does on timeout: deny, or deny + escalate to the inbox. */
  approvalTimeout: Type.Union([Type.Literal("deny"), Type.Literal("escalate")]),
  /**
   * Whether this bot gets the sandboxed `bash` tool (a microsandbox microVM
   * over its durable workspace). Default true; false removes the tool from
   * its every conversation (the privileged `bash_host` is unaffected). Bots
   * created before the toggle existed read as true.
   */
  sandbox: Type.Optional(Type.Boolean()),
  /** Model turns per day across the profile; null = uncapped. */
  dailyTurnBudget: Type.Union([Type.Number(), Type.Null()]),
  /** This profile may distill into the owner-level memory store (the memory keeper). */
  memoryKeeper: Type.Boolean(),
});

export type ProfilePolicies = Static<typeof ProfilePoliciesSchema>;

/**
 * One profile: a user-defined AI entity. Owns its main chat, sessions, DM
 * threads, artifacts and vault scope. Served as plain REST (not a chord
 * object) like every registry in the app.
 */
export const ProfileInfoSchema = Type.Object({
  id: Type.String(),
  owner: Type.String(),
  name: Type.String(),
  description: Type.String(),
  /** Free text, rendered into every request's system prompt for this entity's chats. */
  persona: Type.String(),
  /** IANA zone; cron schedules for this profile render in it. */
  timezone: Type.String(),
  model: Type.Union([ProfileModelSchema, Type.Null()]),
  /** Tool names this entity may use; null = all installed tools. */
  toolAllowlist: Type.Union([Type.Array(Type.String()), Type.Null()]),
  policies: ProfilePoliciesSchema,
  createdAt: Type.Number(),
  archivedAt: Type.Union([Type.Number(), Type.Null()]),
});

export type ProfileInfo = Static<typeof ProfileInfoSchema>;

export const ProfileListSchema = Type.Array(ProfileInfoSchema);

export type ProfileList = Static<typeof ProfileListSchema>;

/** The create/update payload; every field optional except the name on create. */
export const ProfileCreateSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  persona: Type.Optional(Type.String({ maxLength: 8_000 })),
  timezone: Type.Optional(Type.String()),
  model: Type.Optional(ProfileModelSchema),
  toolAllowlist: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
  policies: Type.Optional(ProfilePoliciesSchema),
  /** Spawn-time first turn under the bot's own identity (default true). */
  onboard: Type.Optional(Type.Boolean()),
});

export type ProfileCreate = Static<typeof ProfileCreateSchema>;
