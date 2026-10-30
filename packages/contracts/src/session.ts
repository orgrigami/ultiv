import { hostNamed, method, remote } from "@earendil-works/chord";
import { Type, type Static } from "typebox";

export const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;

/** One selectable model. `id` is `provider/model` (the catalog is models.dev, per configured provider). */
export const ModelInfoSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  provider: Type.String(),
  providerName: Type.String(),
  efforts: Type.Array(ThinkingLevelSchema),
  defaultEffort: ThinkingLevelSchema,
});

export type ModelInfo = Static<typeof ModelInfoSchema>;

/** Cumulative token spend of one session, from the committed transcript. Tokens only — cost stays internal. */
export const UsageSummarySchema = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  reasoning: Type.Union([Type.Number(), Type.Null()]),
  totalTokens: Type.Number(),
});

export type UsageSummary = Static<typeof UsageSummarySchema>;

export const ModelIdSchema = Type.Union([Type.String(), Type.Null()]);

export const EffortSchema = Type.Union([ThinkingLevelSchema, Type.Null()]);

export const SessionConversationIdSchema = Type.Union([Type.String(), Type.Null()]);

export const ToolStepSchema = Type.Object({
  callId: Type.String(),
  name: Type.String(),
  status: Type.Union([Type.Literal("running"), Type.Literal("done"), Type.Literal("error")]),
  input: Type.Unknown(),
  output: Type.Union([Type.String(), Type.Null()]),
  durationMs: Type.Union([Type.Number(), Type.Null()]),
  /** The tool's UI channel (pi-durable `details`), e.g. artifact_write's { id, name, mime, bytes }. Present only when the tool reported it. */
  details: Type.Optional(Type.Unknown()),
});

export type ToolStep = Static<typeof ToolStepSchema>;

/** A tool call waiting for the user's approve/deny decision. */
export const PendingApprovalSchema = Type.Union([
  Type.Null(),
  Type.Object({
    callId: Type.String(),
    name: Type.String(),
    input: Type.Unknown(),
    /** Why the owner is being asked: Jev's read, or the model's one-liner. Null until it lands. */
    reason: Type.Union([Type.String(), Type.Null()]),
  }),
]);

export type PendingApproval = Static<typeof PendingApprovalSchema>;

/** One rendered step of a session: user input, agent output, reasoning, or a tool call. */
export const TranscriptEntrySchema = Type.Union([
  Type.Object({
    id: Type.Number(),
    kind: Type.Literal("input"),
    at: Type.Number(),
    text: Type.String(),
  }),
  Type.Object({
    id: Type.Number(),
    kind: Type.Literal("output"),
    at: Type.Number(),
    text: Type.String(),
    streaming: Type.Boolean(),
    /** Cut short by Stop or Redirect now: the partial reply as it stood. */
    interrupted: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    id: Type.Number(),
    kind: Type.Literal("thinking"),
    at: Type.Number(),
    text: Type.String(),
  }),
  Type.Object({
    id: Type.Number(),
    kind: Type.Literal("note"),
    at: Type.Number(),
    text: Type.String(),
  }),
  Type.Object({
    id: Type.Number(),
    kind: Type.Literal("tool"),
    at: Type.Number(),
    step: ToolStepSchema,
  }),
]);

export type TranscriptEntry = Static<typeof TranscriptEntrySchema>;

export const TranscriptSchema = Type.Array(TranscriptEntrySchema);

export const PhaseSchema = Type.Union([
  Type.Literal("idle"),
  Type.Literal("working"),
  Type.Literal("error"),
]);

export type Phase = Static<typeof PhaseSchema>;

/** How an owner message sent mid-turn is delivered. */
export const WhenBusySchema = Type.Union([Type.Literal("steer"), Type.Literal("followUp")]);

export type WhenBusy = Static<typeof WhenBusySchema>;

/**
 * How an owner send treats a busy bot: the queue modes above, or `redirect`
 * (explicit, never the default) — stop the running turn at the nearest safe
 * point, keep its partial reply marked interrupted, and answer this instead.
 */
export const SendModeSchema = Type.Union([WhenBusySchema, Type.Literal("redirect")]);

export type SendMode = Static<typeof SendModeSchema>;

/** A message waiting for the running turn: placed at its next step (steer) or after it (followUp). */
export const QueuedInputSchema = Type.Object({
  id: Type.String(),
  text: Type.String(),
  mode: WhenBusySchema,
});

export type QueuedInput = Static<typeof QueuedInputSchema>;

/** What withdrawing a queued message found: removed, already in the turn, already answered, or unknown. */
export const WithdrawStatusSchema = Type.Union([
  Type.Literal("aborted"),
  Type.Literal("already_placed"),
  Type.Literal("settled"),
  Type.Literal("not_found"),
]);

export type WithdrawStatus = Static<typeof WithdrawStatusSchema>;

export const SessionErrorSchema = Type.Union([Type.String(), Type.Null()]);

/** One agent session: durable, replayable transcript plus the agent's phase. */
export const Session = remote("ultiv.session", {
  version: 16,
  input: Type.Object({ id: Type.String() }),
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
        conversationId: Type.Union([Type.String(), Type.Null()]),
        /** Messages (owner sends and wakes) waiting for the running turn, oldest first. */
        queued: Type.Array(QueuedInputSchema),
      },
      methods: {
        input: method(
          Type.Object({
            text: Type.String(),
            /** Artifact ids to attach; each rides into the prompt as a reference the agent can read. */
            attachments: Type.Optional(Type.Array(Type.String())),
            /**
             * While the bot works: join the running turn at its next step (steer,
             * the default), wait until the turn finishes (followUp), or stop it
             * and answer this instead (redirect).
             */
            whenBusy: Type.Optional(SendModeSchema),
          }),
        ),
        /** Take back a queued message before the turn picks it up. */
        withdraw: method(
          Type.Object({ id: Type.String() }),
          Type.Object({ status: WithdrawStatusSchema }),
        ),
        /**
         * Stop the running turn: withdraw queued inputs, abort, go idle. With
         * `tasks`, also stop this chat's running background tasks (quietly:
         * the bot is not woken to report them).
         */
        interrupt: method(
          Type.Object({ tasks: Type.Optional(Type.Boolean()) }),
          Type.Object({ ok: Type.Boolean(), cancelledTasks: Type.Optional(Type.Number()) }),
        ),
        approve: method(
          Type.Object({
            callId: Type.String(),
            approved: Type.Boolean(),
            /** Also save this tool on the profile's autoApprove list (with approved). */
            always: Type.Optional(Type.Boolean()),
            /** With approved=false: the owner does this one themselves; the agent is told. */
            takeover: Type.Optional(Type.Boolean()),
            /**
             * With approved=true on an editable card (bot_create): the input
             * as the owner corrected it on the form, replacing the proposal.
             */
            input: Type.Optional(Type.Unknown()),
          }),
          Type.Object({
            ok: Type.Boolean(),
            /**
             * The autoApprove entries "always allow" stored; empty or null
             * means the call stays gated by its pattern — nothing was
             * written, and the identical call will card again.
             */
            stored: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
          }),
        ),
        configure: method(
          Type.Object({ model: ModelIdSchema, effort: EffortSchema }),
          Type.Object({ ok: Type.Boolean() }),
        ),
      },
    },
  },
});
