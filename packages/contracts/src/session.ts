import { hostNamed, method, remote } from "@earendil-works/chord";
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
  unknown,
  type Static,
} from "@earendil-works/pi-schema";

export const ThinkingLevelSchema = oneOf(["off", "low", "medium", "high", "xhigh", "max"]);

export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;

/** One selectable model. `id` is `provider/model` (the catalog is models.dev, per configured provider). */
export const ModelInfoSchema = obj(
  {
    id: str(),
    label: str(),
    provider: str(),
    providerName: str(),
    efforts: arr(ThinkingLevelSchema),
    defaultEffort: ThinkingLevelSchema,
    /** Accepted input modalities, e.g. ["text","image"] (models.dev). */
    input: arr(str()),
  },
  { open: true },
);

export type ModelInfo = Static<typeof ModelInfoSchema>;

/** Cumulative token spend of one session, from the committed transcript. Tokens only — cost stays internal. */
export const UsageSummarySchema = obj(
  {
    input: num(),
    output: num(),
    cacheRead: num(),
    reasoning: union([num(), nul()]),
    totalTokens: num(),
  },
  { open: true },
);

export type UsageSummary = Static<typeof UsageSummarySchema>;

export const ModelIdSchema = union([str(), nul()]);

export const EffortSchema = union([ThinkingLevelSchema, nul()]);

export const SessionConversationIdSchema = union([str(), nul()]);

export const ToolStepSchema = obj(
  {
    callId: str(),
    name: str(),
    status: oneOf(["running", "done", "error"]),
    input: unknown(),
    output: union([str(), nul()]),
    durationMs: union([num(), nul()]),
    /** The tool's UI channel (pi-durable `details`), e.g. artifact_write's { id, name, mime, bytes }. Present only when the tool reported it. */
    details: opt(unknown()),
  },
  { open: true },
);

export type ToolStep = Static<typeof ToolStepSchema>;

/** A tool call waiting for the user's approve/deny decision. */
export const PendingApprovalSchema = union([
  nul(),
  obj(
    {
      callId: str(),
      name: str(),
      input: unknown(),
      /** Why the owner is being asked: Jev's read, or the model's one-liner. Null until it lands. */
      reason: union([str(), nul()]),
    },
    { open: true },
  ),
]);

export type PendingApproval = Static<typeof PendingApprovalSchema>;

/** One file an owner attached to an input; rendered as a chip linking to /api/artifacts/:id. */
export const AttachmentRefSchema = obj(
  {
    id: str(),
    name: str(),
    mime: str(),
    bytes: opt(num()),
  },
  { open: true },
);

export type AttachmentRef = Static<typeof AttachmentRefSchema>;

/** One rendered step of a session: user input, agent output, reasoning, or a tool call. */
export const TranscriptEntrySchema = union([
  obj(
    {
      id: num(),
      kind: lit("input"),
      at: num(),
      text: str(),
      /** Files the owner attached; chips/cards resolve through /api/artifacts/:id. */
      attachments: opt(arr(AttachmentRefSchema)),
    },
    { open: true },
  ),
  obj(
    {
      id: num(),
      kind: lit("output"),
      at: num(),
      text: str(),
      streaming: bool(),
      /** Cut short by Stop or Redirect now: the partial reply as it stood. */
      interrupted: opt(bool()),
    },
    { open: true },
  ),
  obj(
    {
      id: num(),
      kind: lit("thinking"),
      at: num(),
      text: str(),
    },
    { open: true },
  ),
  obj(
    {
      id: num(),
      kind: lit("note"),
      at: num(),
      text: str(),
    },
    { open: true },
  ),
  obj(
    {
      id: num(),
      kind: lit("tool"),
      at: num(),
      step: ToolStepSchema,
    },
    { open: true },
  ),
]);

export type TranscriptEntry = Static<typeof TranscriptEntrySchema>;

export const TranscriptSchema = arr(TranscriptEntrySchema);

export const PhaseSchema = oneOf(["idle", "working", "error"]);

export type Phase = Static<typeof PhaseSchema>;

/** How an owner message sent mid-turn is delivered. */
export const WhenBusySchema = oneOf(["steer", "followUp"]);

export type WhenBusy = Static<typeof WhenBusySchema>;

/**
 * How an owner send treats a busy bot: the queue modes above, or `redirect`
 * (explicit, never the default) — stop the running turn at the nearest safe
 * point, keep its partial reply marked interrupted, and answer this instead.
 */
export const SendModeSchema = union([WhenBusySchema, lit("redirect")]);

export type SendMode = Static<typeof SendModeSchema>;

/** A message waiting for the running turn: placed at its next step (steer) or after it (followUp). */
export const QueuedInputSchema = obj(
  {
    id: str(),
    text: str(),
    mode: WhenBusySchema,
  },
  { open: true },
);

export type QueuedInput = Static<typeof QueuedInputSchema>;

/** What withdrawing a queued message found: removed, already in the turn, already answered, or unknown. */
/** `retryQueued`: started the next run with the queue, a run is still working, or nothing is queued. */
export const RetryQueuedStatusSchema = oneOf(["started", "busy", "empty"]);

export const WithdrawStatusSchema = oneOf(["aborted", "already_placed", "settled", "not_found"]);

export type WithdrawStatus = Static<typeof WithdrawStatusSchema>;

export const SessionErrorSchema = union([str(), nul()]);

/** One agent session: durable, replayable transcript plus the agent's phase. */
export const Session = remote("ultiv.session", {
  version: 17,
  input: obj({ id: str() }, { open: true }),
  host: hostNamed("server"),
  variants: {
    default: {
      state: {
        transcript: TranscriptSchema,
        phase: PhaseSchema,
        lastError: SessionErrorSchema,
        pending: PendingApprovalSchema,
        usage: UsageSummarySchema,
        model: ModelIdSchema,
        effort: EffortSchema,
        /** This session's durable conversation id; null until the harness maps it. */
        conversationId: union([str(), nul()]),
        /** Messages (owner sends and wakes) waiting for the running turn, oldest first. */
        queued: arr(QueuedInputSchema),
      },
      methods: {
        input: method(
          obj(
            {
              text: str(),
              /** Artifact ids to attach; each rides into the prompt as a reference the agent can read. */
              attachments: opt(arr(str())),
              /**
               * While the bot works: join the running turn at its next step (steer,
               * the default), wait until the turn finishes (followUp), or stop it
               * and answer this instead (redirect).
               */
              whenBusy: opt(SendModeSchema),
            },
            { open: true },
          ),
        ),
        /** Take back a queued message before the turn picks it up. */
        withdraw: method(
          obj({ id: str() }, { open: true }),
          obj({ status: WithdrawStatusSchema }, { open: true }),
        ),
        /**
         * After a failed or cut-off turn, queued messages stay queued and are
         * never sent by themselves (D3): Retry sends them, oldest first.
         */
        retryQueued: method(
          obj({}, { open: true }),
          obj({ status: RetryQueuedStatusSchema }, { open: true }),
        ),
        /**
         * Stop the running turn: withdraw queued inputs, abort, go idle. With
         * `tasks`, also stop this chat's running background tasks (quietly:
         * the bot is not woken to report them).
         */
        interrupt: method(
          obj({ tasks: opt(bool()) }, { open: true }),
          obj({ ok: bool(), cancelledTasks: opt(num()) }, { open: true }),
        ),
        approve: method(
          obj(
            {
              callId: str(),
              approved: bool(),
              /** Also save this tool on the profile's autoApprove list (with approved). */
              always: opt(bool()),
              /** With approved=false: the owner does this one themselves; the agent is told. */
              takeover: opt(bool()),
              /**
               * With approved=true on an editable card (bot_create): the input
               * as the owner corrected it on the form, replacing the proposal.
               */
              input: opt(unknown()),
            },
            { open: true },
          ),
          obj(
            {
              ok: bool(),
              /**
               * The autoApprove entries "always allow" stored; empty or null
               * means the call stays gated by its pattern — nothing was
               * written, and the identical call will card again.
               */
              stored: opt(union([arr(str()), nul()])),
            },
            { open: true },
          ),
        ),
        configure: method(
          obj({ model: ModelIdSchema, effort: EffortSchema }, { open: true }),
          obj({ ok: bool() }, { open: true }),
        ),
      },
    },
  },
});
