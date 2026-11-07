import { Type, type Static } from "typebox";

/** One background task: an agent turn the entity runs in its own conversation. */
export const TaskStatusSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("done"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);

export type TaskStatus = Static<typeof TaskStatusSchema>;

/** One progress line a running task posted for its owner. */
export const TaskUpdateSchema = Type.Object({ at: Type.Number(), text: Type.String() });

export type TaskUpdate = Static<typeof TaskUpdateSchema>;

/** Any JSON value: what a structured task result and its schema are stored as. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
const JsonSchema = Type.Unsafe<Json>(Type.Unknown());

export const TaskInfoSchema = Type.Object({
  id: Type.String(),
  /** The app session the task belongs to (registry scoping; may be empty). */
  sessionId: Type.String(),
  /** Registry owner the task was spawned under (see /api/sessions owner scoping). */
  owner: Type.String(),
  /** The durable conversation that spawned the task; woken when it settles. Null for REST spawns. */
  conversationId: Type.Union([Type.String(), Type.Null()]),
  prompt: Type.String(),
  status: TaskStatusSchema,
  result: Type.Union([Type.String(), Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.Number(),
  finishedAt: Type.Union([Type.Number(), Type.Null()]),
  /** false = the spawning conversation has not been told the outcome yet (re-sent on boot). */
  notified: Type.Optional(Type.Boolean()),
  /** A short title the bot chose (≤40 chars); absent on older rows — fall back to the prompt. */
  title: Type.Optional(Type.String()),
  /** The bot the task runs as, kept on the row so the link survives a restart. */
  bot: Type.Optional(Type.Object({ owner: Type.String(), profileId: Type.String() })),
  /**
   * True when the turn that spawned or steered the task had outside content
   * (or wasn't the owner's or a routine's): the whole task counts as outside,
   * so it can't learn skills on its own. Sticky; absent = clean.
   */
  outside: Type.Optional(Type.Boolean()),
  /** Progress updates the task posted for the owner (notify_owner), oldest first. */
  updates: Type.Optional(Type.Array(TaskUpdateSchema)),
  /** The `provider/model` the task runs on, when it differs from its bot's chat model. */
  model: Type.Optional(Type.String()),
  /** The effort the task runs at; absent = the model's default. */
  effort: Type.Optional(Type.String()),
  /**
   * How the outcome reaches the spawning chat: "wake" (default) starts a turn
   * there with it; "note" posts it into the chat without waking the bot (the
   * bot reads it with its next turn). Background routines report as notes.
   */
  report: Type.Optional(Type.Union([Type.Literal("wake"), Type.Literal("note")])),
  /** A JSON Schema the spawn asked the result to match (structured results). */
  resultSchema: Type.Optional(JsonSchema),
  /**
   * The validated result value when `resultSchema` was set; null when the
   * task's reply never matched (the raw text stays in `result`).
   */
  structured: Type.Optional(JsonSchema),
  /** The bot's project this task works toward (task_spawn `project`, or its routine's). */
  projectId: Type.Optional(Type.String()),
  /** The latest step of a running task, as a plain line (list responses only, never stored). */
  lastStep: Type.Optional(Type.String()),
});

export type TaskInfo = Static<typeof TaskInfoSchema>;

/** The projections GET /api/tasks adds to a stored task row (never stored on the doc). */
export const TaskRowSchema = Type.Object({
  ...TaskInfoSchema.properties,
  taskConversationId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  waitingApproval: Type.Optional(
    Type.Object({
      callId: Type.String(),
      name: Type.String(),
      input: Type.Unknown(),
      reason: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
});

/**
 * One row of GET /api/tasks: the stored task plus response-only projections.
 * `waitingApproval` stays OUT of the stored schema — the tasks doc's
 * JsonObject constraint is JSON-strict and tool inputs are arbitrary — so
 * this is the ROW schema's static, and the client treats the input as
 * opaque (`unknown`), exactly like the activity route.
 */
export type TaskRow = Static<typeof TaskRowSchema>;

/** One gate waiting on a task's own conversation (list responses only). */
export type WaitingApproval = NonNullable<TaskRow["waitingApproval"]>;

export const TaskListSchema = Type.Array(TaskRowSchema);

export type TaskList = Static<typeof TaskListSchema>;
