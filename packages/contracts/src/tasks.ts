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
  type Schema,
  type Static,
} from "@earendil-works/pi-schema";

/**
 * One background task: an agent turn the entity runs in its own conversation.
 * "queued" waits for a free slot (the bot's running limit); it starts by itself.
 */
export const TaskStatusSchema = oneOf(["queued", "running", "done", "failed", "cancelled"]);

export type TaskStatus = Static<typeof TaskStatusSchema>;

/** One progress line a running task posted for its owner. */
export const TaskUpdateSchema = obj({ at: num(), text: str() }, { open: true });

export type TaskUpdate = Static<typeof TaskUpdateSchema>;

/** Any JSON value: what a structured task result and its schema are stored as. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
const JsonSchema = unknown() as Schema<Json>;

const TaskInfoProperties = {
  id: str(),
  /** The app session the task belongs to (registry scoping; may be empty). */
  sessionId: str(),
  /** Registry owner the task was spawned under (see /api/sessions owner scoping). */
  owner: str(),
  /** The durable conversation that spawned the task; woken when it settles. Null for REST spawns. */
  conversationId: union([str(), nul()]),
  prompt: str(),
  status: TaskStatusSchema,
  result: union([str(), nul()]),
  error: union([str(), nul()]),
  createdAt: num(),
  /** When the current run started (a queued task waits first); absent on older rows = createdAt. */
  startedAt: opt(num()),
  finishedAt: union([num(), nul()]),
  /**
   * How many runs the task has had: a finished task continued with
   * task_message runs again in its own conversation, with its context.
   * Absent = 1.
   */
  runs: opt(num()),
  /**
   * The model lane the task's requests ride: "owner" when the owner's own
   * message started (or continued) it, so it is served like a chat; absent =
   * background (routines, mail, wakes).
   */
  lane: opt(lit("owner")),
  /** The input a queued task runs when its slot frees (queued rows only). */
  next: opt(str()),
  /** false = the spawning conversation has not been told the outcome yet (re-sent on boot). */
  notified: opt(bool()),
  /** A short title the bot chose (≤40 chars); absent on older rows — fall back to the prompt. */
  title: opt(str()),
  /** The bot the task runs as, kept on the row so the link survives a restart. */
  bot: opt(obj({ owner: str(), profileId: str() }, { open: true })),
  /**
   * True when the turn that spawned or steered the task had outside content
   * (or wasn't the owner's or a routine's): the whole task counts as outside,
   * so it can't learn skills on its own. Sticky; absent = clean.
   */
  outside: opt(bool()),
  /** Progress updates the task posted for the owner (notify_owner), oldest first. */
  updates: opt(arr(TaskUpdateSchema)),
  /** The `provider/model` the task runs on, when it differs from its bot's chat model. */
  model: opt(str()),
  /** The effort the task runs at; absent = the model's default. */
  effort: opt(str()),
  /**
   * How the outcome reaches the spawning chat: "wake" (default) starts a turn
   * there with it; "note" posts it into the chat without waking the bot (the
   * bot reads it with its next turn). Background routines report as notes.
   */
  report: opt(oneOf(["wake", "note"])),
  /** A JSON Schema the spawn asked the result to match (structured results). */
  resultSchema: opt(JsonSchema),
  /**
   * The validated result value when `resultSchema` was set; null when the
   * task's reply never matched (the raw text stays in `result`).
   */
  structured: opt(JsonSchema),
  /** The bot's project this task works toward (task_spawn `project`, or its routine's). */
  projectId: opt(str()),
  /** The latest step of a running task, as a plain line (list responses only, never stored). */
  lastStep: opt(str()),
};

export const TaskInfoSchema = obj(TaskInfoProperties, { open: true });

export type TaskInfo = Static<typeof TaskInfoSchema>;

/** The projections GET /api/tasks adds to a stored task row (never stored on the doc). */
export const TaskRowSchema = obj(
  {
    ...TaskInfoProperties,
    taskConversationId: opt(union([str(), nul()])),
    waitingApproval: opt(
      obj(
        {
          callId: str(),
          name: str(),
          input: unknown(),
          reason: union([str(), nul()]),
        },
        { open: true },
      ),
    ),
  },
  { open: true },
);

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

/** The most background tasks one bot may run at once (per bot and as the workspace default). */
export const TASK_LIMIT_MAX = 10;

/** The running limit when neither the bot, Settings nor SPRIESSEN_MAX_RUNNING_TASKS set one. */
export const TASK_LIMIT_DEFAULT = 3;

/**
 * GET/PUT /api/settings/tasks: the workspace default for how many background
 * tasks a bot runs at once, and where it comes from ("db" = stored in
 * Settings, "env" = SPRIESSEN_MAX_RUNNING_TASKS, "default" = built in).
 */
export const TaskSettingsSchema = obj(
  {
    maxRunningTasks: num(),
    source: oneOf(["db", "env", "default"]),
  },
  { open: true },
);

export type TaskSettings = Static<typeof TaskSettingsSchema>;

export const TaskListSchema = arr(TaskRowSchema);

export type TaskList = Static<typeof TaskListSchema>;
