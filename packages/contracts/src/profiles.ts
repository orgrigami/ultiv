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
import { TASK_LIMIT_MAX } from "./tasks.ts";

/** A profile's starting model/effort for new chats; null = the mind's default. */
export const ProfileModelSchema = obj(
  {
    id: str(),
    effort: str(),
  },
  { open: true },
);

export type ProfileModel = Static<typeof ProfileModelSchema>;

/** How gated tool calls get approved for this profile: the owner each time ('manual'), Jev as the gate ('jev'), or nobody ('yolo'). */
export const ProfileApprovalModeSchema = oneOf(["manual", "jev", "yolo"]);

export type ProfileApprovalMode = Static<typeof ProfileApprovalModeSchema>;

/** Behavior policy of one profile: initiation rights, approvals, budget. */
export const ProfilePoliciesSchema = obj(
  {
    /** Sibling ids this entity may message autonomously; ["*"] (default) = all, [] = locked. */
    canInitiate: arr(str()),
    /**
     * Gated tools pre-approved for this profile. An entry is a bare tool name
     * ("bash" approves every bash call — the owner's whole-tool grant) or a
     * `tool:pattern` sub-action rule ("bash:git *"): an anchored glob over the
     * call's command/action text (`*` any run, `?` one char — wildcards cannot
     * cross a `;`/`&&`/`|` boundary; else literal, case-sensitive). A pattern
     * match that looks destructive is refused to the normal gate, and bash
     * calls beyond the VM (`target: "host"` / `target: "node"`) never bare- or
     * pattern-match: their only rule is an exact one, `bash@host:=<script>` /
     * `bash@node:<nodeId>:=<script>`, matching that script on that target and
     * nothing else ("Always allow this exact command"). Floors (first-use
     * credential/connector, `secret_request`) outrank every entry.
     */
    autoApprove: arr(str()),
    /** Who answers a gated call: the owner each time, Jev as the gate, or nobody. */
    approvalMode: ProfileApprovalModeSchema,
    /** What a pending approval does on timeout: deny, or deny + escalate to the inbox. */
    approvalTimeout: oneOf(["deny", "escalate"]),
    /**
     * Whether this bot gets the sandboxed `bash` tool (a microsandbox microVM
     * over its durable workspace). Default true; false removes the tool from
     * its every conversation — including its host and node targets. Bots
     * created before the toggle existed read as true.
     */
    sandbox: opt(bool()),
    /**
     * Whether this bot saves what it learns as skills on its own (skill_learn,
     * no approval, one-tap undo). Default true; false refuses skill_learn and
     * drops the learning rule from its prompt. Older bots read as true.
     */
    learnSkills: opt(bool()),
    /** Model turns per day across the profile; null = uncapped. */
    dailyTurnBudget: union([num(), nul()]),
    /** This profile may distill into the owner-level memory store (the memory keeper). */
    memoryKeeper: bool(),
    /**
     * Seconds a model request may take to stream its first token (text,
     * reasoning or a tool call) before the turn is stopped with a note in the
     * chat. Null or absent = the default, 60 s. Raise it for slow reasoning models.
     */
    firstTokenDeadlineSec: opt(union([num(), nul()])),
    /**
     * Minutes one turn may run, from its first model request to its answer,
     * before it is stopped with a note in the chat (approval waits do not
     * count). Null or absent = the default, 15 min.
     */
    turnDeadlineMin: opt(union([num(), nul()])),
    /**
     * The model this bot's background work runs on: tasks it spawns and
     * routines that run as background tasks. Null or absent = the workspace's
     * `SPRIESSEN_BACKGROUND_MODEL` when set, else the bot's own chat model.
     */
    backgroundModel: opt(union([ProfileModelSchema, nul()])),
    /**
     * Background tasks this bot runs at once; more wait in its queue and start
     * as slots free. Null or absent = the workspace default (Settings).
     */
    maxRunningTasks: opt(union([num(), nul()])),
  },
  { open: true },
);

export type ProfilePolicies = Static<typeof ProfilePoliciesSchema>;

/**
 * The per-bot numbers' bounds (deadlines, the task limit) and the labels the
 * Edit-bot dialog shows. The server's refusal and the dialog's own check use
 * the same words.
 */
export const POLICY_NUMBER_FIELDS = {
  firstTokenDeadlineSec: { label: "First reply (seconds)", min: 10, max: 1_800 },
  turnDeadlineMin: { label: "Whole turn (minutes)", min: 1, max: 720 },
  maxRunningTasks: { label: "Tasks at once", min: 1, max: TASK_LIMIT_MAX },
} as const;

export type PolicyNumberField = keyof typeof POLICY_NUMBER_FIELDS;

/** What is wrong with a policy number, in the dialog's words; null when it is fine (absent = default). */
export const policyNumberProblem = (field: PolicyNumberField, value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  const { label, min, max } = POLICY_NUMBER_FIELDS[field];
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? null
    : `${label} must be a whole number from ${min} to ${max}. Leave it empty for the default.`;
};

/**
 * One profile: a user-defined AI entity. Owns its main chat, sessions, DM
 * threads, artifacts and vault scope. Served as plain REST (not a chord
 * object) like every registry in the app.
 */
export const ProfileInfoSchema = obj(
  {
    id: str(),
    owner: str(),
    name: str(),
    description: str(),
    /** Free text, rendered into every request's system prompt for this entity's chats. */
    persona: str(),
    /** IANA zone; cron schedules for this profile render in it. */
    timezone: str(),
    model: union([ProfileModelSchema, nul()]),
    /** Tool names this entity may use; null = all installed tools. */
    toolAllowlist: union([arr(str()), nul()]),
    policies: ProfilePoliciesSchema,
    createdAt: num(),
    archivedAt: union([num(), nul()]),
    /**
     * The bot's home: one team id, or null for an org bot (the org
     * itself). Exactly one home, always; absent on pre-org rows reads as null.
     */
    teamId: opt(union([str(), nul()])),
    /**
     * The bot's own host-access switch (tools that run on the server's own
     * machine). Effective access ANDs it with its home's levels. Absent on
     * pre-org rows reads as false; the org migration stamps existing bots true.
     */
    hostAccess: opt(bool()),
  },
  { open: true },
);

export type ProfileInfo = Static<typeof ProfileInfoSchema>;

export const ProfileListSchema = arr(ProfileInfoSchema);

export type ProfileList = Static<typeof ProfileListSchema>;

/** The create/update payload; every field optional except the name on create. */
export const ProfileCreateSchema = obj(
  {
    name: str({ minLength: 1, maxLength: 80 }),
    description: opt(str({ maxLength: 500 })),
    persona: opt(str({ maxLength: 8_000 })),
    timezone: opt(str()),
    model: opt(ProfileModelSchema),
    toolAllowlist: opt(union([arr(str()), nul()])),
    policies: opt(ProfilePoliciesSchema),
    /** Spawn-time first turn under the bot's own identity (default true). */
    onboard: opt(bool()),
    /** The team to place the bot in; omitted or null = an org bot. */
    teamId: opt(union([str(), nul()])),
    /** The bot's own host-access switch; org owner only may set it (F3). */
    hostAccess: opt(bool()),
  },
  { open: true },
);

export type ProfileCreate = Static<typeof ProfileCreateSchema>;
