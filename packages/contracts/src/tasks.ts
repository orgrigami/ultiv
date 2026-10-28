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
  /** Progress updates the task posted for the owner (notify_owner), oldest first. */
  updates: Type.Optional(Type.Array(TaskUpdateSchema)),
  /** The latest step of a running task, as a plain line (list responses only, never stored). */
  lastStep: Type.Optional(Type.String()),
});

export type TaskInfo = Static<typeof TaskInfoSchema>;

/**
 * One row of GET /api/tasks: the stored task plus response-only projections.
 * `waitingApproval` stays OUT of the stored schema — its input is arbitrary
 * JSON (`unknown` is not JsonValue, which would fail the tasks doc's
 * JsonObject constraint), so the row type carries it with a JSON-safe input,
 * cast at the creation boundary (the REST list route).
 */
export type TaskRow = TaskInfo & {
  /** The task's own conversation id (the decide target for its approval). */
  taskConversationId?: string | null;
  waitingApproval?: WaitingApproval;
};

/** One gate waiting on a task's own conversation (list responses only). */
export type WaitingApproval = {
  callId: string;
  name: string;
  input: JsonValue;
  reason: string | null;
};

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const TaskListSchema = Type.Array(TaskInfoSchema);

export type TaskList = Static<typeof TaskListSchema>;
