/**
 * The Tasks faculty: background work the entity runs in its own durable
 * conversation — the mind's sub-agent surface. `spawn` admits a prompt into a
 * fresh conversation and settles it in the background; when a task settles it
 * WAKES the conversation that spawned it with the outcome, so the parent ends
 * its turn instead of polling. A task runs AS its bot: the binder (wired by
 * the entity once the profiles index exists) creates the task's conversation
 * with the bot's own model and tools and indexes it under the bot BEFORE the
 * first turn, and the bot is kept on the row so a restart rebinds it.
 * Restarts do not kill tasks: once bound, every still-running task is resumed
 * with a continuation input (the transcript is durable), and only a genuinely
 * dead run ends up failed. REST and the act's task tools read the same doc.
 * Parts: store.ts (the doc), wake.ts (the parent wake).
 */
import { randomUUID } from "node:crypto";
import type { Conversation, Submission } from "@earendil-works/pi-durable";
import { Context, Effect, Layer } from "effect";
import { External } from "@spreissen/core";
import type { TaskInfo, TaskList } from "@spreissen/contracts";
import { Converse, type ConverseService } from "../converse/converse.ts";
import { findTask, readTasks, taskConversationKey, updateTask, writeTasks } from "./store.ts";
import { notifyOwner, type NotifyOutcome } from "./notify.ts";
import { recentSteps } from "./steps.ts";
import { owed, wakeParent } from "./wake.ts";

export { TasksDoc, taskConversationKey, titleOf } from "./store.ts";
export { TASK_UPDATE_KIND, NOTIFY_CHARS, NOTIFY_INTERVAL_MS } from "./notify.ts";

/** The bot a task runs as. */
export type TaskBot = NonNullable<TaskInfo["bot"]>;

/**
 * Binds a task conversation to its bot: ensures the conversation under `key`
 * (created with the bot's agent when new) and indexes it as the bot's task.
 * `stored` is the bot already on the row (resume); otherwise it is resolved
 * from the spawning conversation. Null when there is no bot (unscoped spawn).
 */
export type TaskBinder = (
  key: string,
  parentConversationId: string | null,
  stored: TaskBot | null,
) => Promise<TaskBot | null>;

export interface TasksService {
  /** Start a background turn in a fresh conversation; returns it running. */
  readonly spawn: (input: {
    readonly sessionId: string;
    readonly owner: string;
    /** Conversation to wake when the task settles; null = nobody (REST spawns). */
    readonly conversationId: string | null;
    readonly prompt: string;
    /** A short title for the owner's task list (≤40 chars); optional. */
    readonly title?: string;
  }) => Effect.Effect<TaskInfo, External>;
  readonly get: (id: string) => Effect.Effect<TaskInfo | undefined, External>;
  readonly list: () => Effect.Effect<TaskList, External>;
  /**
   * Stop a running task: abort its conversation, mark cancelled, wake the
   * parent once — or, with `quiet` (the owner stopped the whole chat), never.
   */
  readonly cancel: (
    id: string,
    options?: { readonly quiet?: boolean },
  ) => Effect.Effect<boolean, External>;
  /**
   * Remove a task from the registry entirely; a still-running task is
   * cancelled first (and its parent woken). The durable transcript stays.
   */
  readonly remove: (
    id: string,
  ) => Effect.Effect<{ readonly removed: boolean; readonly cancelled: boolean }, External>;
  /**
   * Steer a RUNNING task with new instructions, like the owner steering a
   * chat: the text lands at the task's next step (or right after its current
   * reply). "not_running" when the task is unknown or already settled.
   */
  readonly message: (id: string, text: string) => Effect.Effect<"sent" | "not_running", External>;
  /** A task's last few steps as plain lines, oldest first ([] when none). */
  readonly steps: (id: string, count?: number) => Promise<string[]>;
  /** Post a progress line into the parent chat (rate-limited; never wakes the parent). */
  readonly notify: (id: string, text: string) => Effect.Effect<NotifyOutcome, External>;
  /** Hear each task settle (done or failed). Returns the unsubscribe. */
  readonly listen: (fn: (task: TaskInfo) => void) => () => void;
  /** The task a conversation belongs to, if it is a task's own conversation. */
  readonly taskOf: (conversationId: string) => Effect.Effect<TaskInfo | undefined, External>;
  /** True when the conversation belongs to a background task: tasks cannot spawn sub-tasks. */
  readonly isTaskConversation: (conversationId: string) => Effect.Effect<boolean, External>;
  /**
   * Wire the bot binder and resume still-running tasks. Called once by the
   * entity after the profiles index exists, so no task turn runs unbound.
   */
  readonly attach: (binder: TaskBinder) => Promise<void>;
}

export class Tasks extends Context.Service<Tasks, TasksService>()("spreissen/mind/Tasks") {}

const TITLE_CHARS = 40;

/** Running tasks one bot may have at once (env ULTIV_MAX_RUNNING_TASKS overrides). */
export const MAX_RUNNING_TASKS = Math.max(1, Number(process.env.ULTIV_MAX_RUNNING_TASKS) || 3);

/** The refusal a spawn over the cap gets, naming what is running. */
export const runningCapMessage = (running: readonly TaskInfo[]): string =>
  `You already have ${running.length} tasks running (the limit is ${MAX_RUNNING_TASKS}): ` +
  `${running.map((task) => task.id).join(", ")}. Wait for one to finish, cancel one, or send ` +
  "new instructions to one with task_message.";

const RESUME_NOTE =
  "[resume] You were interrupted by a server restart. Continue the task from where the " +
  "transcript left off and produce the final deliverable now.";

/** Framing the task sees once, above its brief (the row keeps the raw prompt). */
export const TASK_BRIEF =
  "[task brief] You are a background task your bot started; your final reply is the result " +
  "it receives. A [from parent] line is a new instruction from it — follow it. For long " +
  "work, post a one-line milestone to your owner with notify_owner (rarely; never the result).";

/** The wake prefix a parent bot's task_message arrives under, in the task's chat. */
export const FROM_PARENT = "[from parent]";

/** Mutable wiring shared by the service's parts. */
interface TaskRuntime {
  readonly converse: ConverseService;
  binder: TaskBinder | null;
  /** Parent messages admitted into a running task, settled before it reports. */
  readonly followers: Map<string, Submission[]>;
  /** Tasks past their last drain: new messages are refused, not lost. */
  readonly closing: Set<string>;
  /** Hear a task settle (done or failed; never a cancel). */
  readonly listeners: Set<(task: TaskInfo) => void>;
}

/** Ensure and bind the task's conversation before any turn reaches it. */
const bindTask = async (
  rt: TaskRuntime,
  id: string,
  parent: string | null,
  stored: TaskBot | null,
): Promise<TaskBot | null> => {
  const key = taskConversationKey(id);
  const bot = rt.binder === null ? null : await rt.binder(key, parent, stored).catch(() => null);
  // Unbound (no bot, or the binder failed): the conversation still exists.
  if (bot === null) await Effect.runPromise(rt.converse.ensure(key));
  return bot;
};

/**
 * Settle the parent messages a task received while it ran. A message steered
 * into the run settles with the same answer; one that arrived as the reply
 * was ending starts its own turn — its answer becomes the task's result.
 */
const drainFollowers = async (
  rt: TaskRuntime,
  id: string,
  conversation: Conversation,
  text: string,
): Promise<string> => {
  let latest = text;
  const queue = (): Submission[] => rt.followers.get(id) ?? [];
  for (let pass = 0; pass < 2; pass += 1) {
    // The second pass runs after `closing` is set: nothing can slip in after it.
    if (pass === 1) rt.closing.add(id);
    while (queue().length > 0) {
      const next = queue().shift() as Submission;
      const settled = await Effect.runPromise(rt.converse.settle(conversation, next));
      if (settled.text.trim() !== "") latest = settled.text;
    }
  }
  return latest;
};

/** Admit a parent message into a running task's conversation (steer semantics). */
const messageTask =
  (rt: TaskRuntime): TasksService["message"] =>
  (id, text) =>
    Effect.gen(function* () {
      const task = yield* findTask(rt.converse, id);
      if (task === undefined || task.status !== "running" || rt.closing.has(id)) {
        return "not_running" as const;
      }
      const conversation = yield* rt.converse.ensure(taskConversationKey(id));
      const submission = yield* rt.converse.submit(conversation, `${FROM_PARENT} ${text}`, "steer");
      rt.followers.set(id, [...(rt.followers.get(id) ?? []), submission]);
      return "sent" as const;
    });

/**
 * Settles a spawned (or resumed) task in the background: the registry doc
 * carries the outcome and the spawning conversation is woken with it. A
 * cancellation wins over both outcomes: once the doc says "cancelled", the
 * runner keeps its hands off.
 */
const runTask = (rt: TaskRuntime, task: TaskInfo, prompt: string): void => {
  const { converse } = rt;
  void (async () => {
    try {
      const conversation = await Effect.runPromise(converse.ensure(taskConversationKey(task.id)));
      const first = await Effect.runPromise(converse.turn(conversation, prompt));
      const result = { text: await drainFollowers(rt, task.id, conversation, first.text) };
      await Effect.runPromise(
        updateTask(converse, task.id, (current) =>
          current.status === "cancelled"
            ? current
            : {
                ...current,
                status: "done",
                result: result.text,
                finishedAt: Date.now(),
                ...owed(current),
              },
        ),
      );
    } catch (cause) {
      const error = String(cause).slice(0, 500);
      await Effect.runPromise(
        updateTask(converse, task.id, (current) =>
          current.status === "cancelled"
            ? current
            : { ...current, status: "failed", error, finishedAt: Date.now(), ...owed(current) },
        ),
      ).catch(() => undefined);
    }
    rt.followers.delete(task.id);
    rt.closing.delete(task.id);
    await announce(rt, task.id);
    await wakeParent(converse, task.id);
  })();
};

/** Tell listeners a task settled; a cancelled or vanished row stays quiet. */
const announce = async (rt: TaskRuntime, id: string): Promise<void> => {
  const settled = await Effect.runPromise(findTask(rt.converse, id)).catch(() => undefined);
  if (settled === undefined || (settled.status !== "done" && settled.status !== "failed")) return;
  for (const fn of rt.listeners) {
    try {
      fn(settled);
    } catch (cause) {
      console.error("task listener failed:", cause);
    }
  }
};

/**
 * Stop a running task: abort its conversation, mark cancelled, wake the
 * parent. Idempotent — only a running task is cancelled.
 */
const cancelTask = (
  converse: ConverseService,
  id: string,
  quiet = false,
): Effect.Effect<boolean, External> =>
  Effect.gen(function* () {
    const task = yield* findTask(converse, id);
    if (task === undefined || task.status !== "running") return false;
    // Stop the work first, then write the outcome: the runner honors the
    // cancelled status and keeps its hands off when it settles.
    const conversation = yield* converse.ensure(taskConversationKey(id));
    yield* converse.interrupt(conversation);
    yield* updateTask(converse, id, (current) =>
      current.status === "running"
        ? {
            ...current,
            status: "cancelled",
            error: "cancelled by the user",
            finishedAt: Date.now(),
            ...(quiet ? { notified: true } : owed(current)),
          }
        : current,
    );
    yield* Effect.tryPromise({
      try: () => wakeParent(converse, id),
      catch: (cause) => new External({ op: "task cancel wake", cause }),
    }).pipe(Effect.ignore);
    return true;
  });

const spawnTask =
  (rt: TaskRuntime): TasksService["spawn"] =>
  (input) =>
    Effect.gen(function* () {
      const id = randomUUID();
      // The conversation exists, with the bot's agent, and is indexed under
      // the bot before the task is admitted: the first turn already runs as
      // the bot, and an unrecorded input never leaves an orphan transcript.
      const bot = yield* Effect.tryPromise({
        try: () => bindTask(rt, id, input.conversationId, null),
        catch: (cause) => new External({ op: "task bind", cause }),
      });
      const title = input.title?.trim().slice(0, TITLE_CHARS) ?? "";
      const task: TaskInfo = {
        id,
        sessionId: input.sessionId,
        owner: input.owner,
        conversationId: input.conversationId,
        prompt: input.prompt,
        status: "running",
        result: null,
        error: null,
        createdAt: Date.now(),
        finishedAt: null,
        ...(title !== "" ? { title } : {}),
        ...(bot !== null ? { bot } : {}),
      };
      yield* Effect.flatMap(readTasks(rt.converse), (tasks) =>
        writeTasks(rt.converse, [...tasks, task]),
      );
      runTask(rt, task, `${TASK_BRIEF}\n\n${input.prompt}`);
      return task;
    });

/**
 * Boot-time resume: the in-process runner dies with the old process, but the
 * task's transcript is durable. Rebind each still-running task to its bot
 * (from the row, else from the spawning chat), re-admit a continuation input
 * and re-attach a runner. A task that finished but whose parent was never
 * woken (the crash hit in between) wakes the parent now.
 */
const resumeRunning = async (rt: TaskRuntime): Promise<void> => {
  const tasks = await Effect.runPromise(readTasks(rt.converse));
  for (const task of tasks) {
    if (task.status === "running") {
      const bot = await bindTask(rt, task.id, task.conversationId, task.bot ?? null);
      if (bot !== null && task.bot === undefined) {
        await Effect.runPromise(updateTask(rt.converse, task.id, (row) => ({ ...row, bot })));
      }
      runTask(rt, task, RESUME_NOTE);
    } else if (task.notified === false) void wakeParent(rt.converse, task.id);
  }
};

const taskOfConversation = (
  converse: ConverseService,
  conversationId: string,
): Effect.Effect<TaskInfo | undefined, External> =>
  Effect.flatMap(readTasks(converse), (tasks) =>
    Effect.map(
      Effect.forEach(tasks, (task) => converse.conversationIdOf(taskConversationKey(task.id)), {
        concurrency: "unbounded",
      }),
      (ids) => tasks[ids.findIndex((id) => id !== undefined && String(id) === conversationId)],
    ),
  );

export const tasksService = (converse: ConverseService): TasksService => {
  const rt: TaskRuntime = {
    converse,
    binder: null,
    followers: new Map(),
    closing: new Set(),
    listeners: new Set(),
  };
  let attached = false;
  return {
    spawn: spawnTask(rt),
    get: (id) => findTask(converse, id),
    list: () => readTasks(converse),
    cancel: (id, options) => cancelTask(converse, id, options?.quiet === true),
    message: messageTask(rt),
    steps: (id, count) => recentSteps(converse, id, count),
    remove: (id) =>
      Effect.gen(function* () {
        const task = yield* findTask(converse, id);
        if (task === undefined) return { removed: false, cancelled: false };
        const cancelled = task.status === "running" ? yield* cancelTask(converse, id) : false;
        yield* Effect.flatMap(readTasks(converse), (tasks) =>
          writeTasks(
            converse,
            tasks.filter((candidate) => candidate.id !== id),
          ),
        );
        return { removed: true, cancelled };
      }),
    notify: (id, text) => notifyOwner(converse, id, text),
    listen: (fn) => {
      rt.listeners.add(fn);
      return () => void rt.listeners.delete(fn);
    },
    taskOf: (conversationId) => taskOfConversation(converse, conversationId),
    isTaskConversation: (conversationId) =>
      Effect.map(taskOfConversation(converse, conversationId), (task) => task !== undefined),
    attach: async (binder) => {
      rt.binder = binder;
      if (attached) return;
      attached = true;
      await resumeRunning(rt).catch((cause) => console.error("task resume failed:", cause));
    },
  };
};

export const tasksLayer: Layer.Layer<Tasks, External, Converse> = Layer.effect(
  Tasks,
  Effect.gen(function* () {
    return tasksService(yield* Converse);
  }),
);
