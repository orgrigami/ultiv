/**
 * The Tasks faculty: background work the entity runs in its own durable
 * conversation — the mind's sub-agent surface. `spawn` admits a prompt into a
 * fresh conversation and settles it in the background; when a task settles it
 * WAKES the conversation that spawned it with the outcome (and the files it
 * wrote), so the parent ends its turn instead of polling. A task runs AS its
 * bot: the binder (wired by the entity once the profiles index exists)
 * creates the task's conversation with the bot's own model and tools and
 * indexes it under the bot BEFORE the first turn, and the bot is kept on the
 * row so a restart rebinds it. A bot runs at most its limit of tasks at once;
 * the rest queue and start as slots free. A settled task can be CONTINUED
 * with a message: it runs again with its own context.
 * Restarts do not kill tasks: once bound, every still-running task is resumed
 * with a continuation input (the transcript is durable), and only a genuinely
 * dead run ends up failed. REST and the act's task tools read the same doc.
 * Parts: store.ts (the doc), run.ts (one run), queue.ts (slots),
 * continue.ts (messages and continuations), wake.ts (the parent wake).
 */
import { randomUUID } from "node:crypto";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Context, Effect, Layer } from "effect";
import { External, InvalidInput } from "@spriessen/core";
import type { Json, TaskInfo, TaskList } from "@spriessen/contracts";
import { Converse, type ConverseService } from "../converse/converse.ts";
import {
  findTask,
  onTaskChange,
  readTasks,
  taskConversationKey,
  updateTask,
  writeTasks,
} from "./store.ts";
import { notifyOwner, type NotifyOutcome } from "./notify.ts";
import { recentSteps } from "./steps.ts";
import type { TaskModel } from "./model.ts";
import { schemaBrief } from "./structured.ts";
import { messageTask, type MessageOptions, type MessageOutcome } from "./continue.ts";
import { budgetMessage, overBudget, placementOf, pumpQueue, queueFullMessage } from "./queue.ts";
import {
  bindTask,
  cancelTask,
  runTask,
  serial,
  wakeWithFiles,
  type TaskBinder,
  type TaskBot,
  type TaskRuntime,
  type TaskWiring,
} from "./run.ts";
import { stopChatWork, stopTaskTree, type TreeStop } from "./tree.ts";

export { TasksDoc, taskConversationKey, titleOf } from "./store.ts";
export { TASK_UPDATE_KIND, NOTIFY_CHARS, NOTIFY_INTERVAL_MS } from "./notify.ts";
export { FROM_PARENT, type MessageOutcome } from "./continue.ts";
export type { TaskBinder, TaskBot, TaskWiring } from "./run.ts";

export interface TasksService {
  /**
   * Start a background turn in a fresh conversation; returns it running, or
   * queued when the bot is at its limit. Fails InvalidInput when the bot's
   * queue is full.
   */
  readonly spawn: (input: {
    readonly sessionId: string;
    readonly owner: string;
    /** Conversation to wake when the task settles; null = nobody (REST spawns). */
    readonly conversationId: string | null;
    readonly prompt: string;
    /** A short title for the owner's task list (≤40 chars); optional. */
    readonly title?: string;
    /** The spawning turn had outside content: stored on the row (see TaskInfo.outside). */
    readonly outside?: boolean;
    /** The model the task runs on (background-model resolution, model.ts); absent = the bot's. */
    readonly model?: TaskModel;
    /** How the outcome reaches the spawning chat (TaskInfo.report); default "wake". */
    readonly report?: "wake" | "note";
    /** The owner's own message asked for it: its requests ride the owner lane. */
    readonly lane?: "owner";
    /** A JSON Schema the result must match (structured.ts); checked by the caller. */
    readonly resultSchema?: Json;
    /** The bot's project the task works toward (projects/links.ts); resolved by the caller. */
    readonly projectId?: string;
  }) => Effect.Effect<TaskInfo, External | InvalidInput>;
  readonly get: (id: string) => Effect.Effect<TaskInfo | undefined, External>;
  readonly list: () => Effect.Effect<TaskList, External>;
  /**
   * Stop a running or queued task: abort its conversation, mark cancelled,
   * wake the parent once — or, with `quiet` (the owner stopped the whole
   * chat), never.
   */
  readonly cancel: (
    id: string,
    options?: { readonly quiet?: boolean },
  ) => Effect.Effect<boolean, External>;
  /**
   * Stop one task WITH its work tree (tree.ts): the task, then the mail its
   * conversation sent and the background jobs it started. Undefined when the
   * task was not live.
   */
  readonly stopTree: (id: string) => Effect.Effect<TreeStop | undefined, External>;
  /**
   * Stop a chat's whole work tree: its queued tasks first, then the running
   * ones, then their mail and jobs (quiet cancels; the chat itself was just
   * interrupted by the caller).
   */
  readonly stopChatWork: (conversationId: string) => Effect.Effect<TreeStop, External>;
  /**
   * Remove a task from the registry entirely; a still-running or queued task is
   * cancelled first (and its parent woken). The durable transcript stays.
   */
  readonly remove: (
    id: string,
  ) => Effect.Effect<{ readonly removed: boolean; readonly cancelled: boolean }, External>;
  /**
   * Message a task (continue.ts): steer it while it runs, add to its input
   * while it waits, or continue it — a new run with its own context — once
   * it settled.
   */
  readonly message: (
    id: string,
    text: string,
    options?: MessageOptions,
  ) => Effect.Effect<MessageOutcome, External>;
  /** A task's last few steps as plain lines, oldest first ([] when none). */
  readonly steps: (id: string, count?: number) => Promise<string[]>;
  /** Post a progress line into the parent chat (rate-limited; never wakes the parent). */
  readonly notify: (id: string, text: string) => Effect.Effect<NotifyOutcome, External>;
  /** Hear each task settle (done or failed). Returns the unsubscribe. */
  readonly listen: (fn: (task: TaskInfo) => void) => () => void;
  /** Fires after any task row changes (the poll-free signal for surfaces). */
  readonly onUpdate: (fn: () => void) => () => void;
  /** The task a conversation belongs to, if it is a task's own conversation. */
  readonly taskOf: (conversationId: string) => Effect.Effect<TaskInfo | undefined, External>;
  /** The model lane a task conversation's requests ride (lanes.ts); "background" unless the owner asked. */
  readonly laneOf: (conversationId: string) => Promise<"owner" | "background">;
  /** Start queued work that now fits (call after a running limit was raised). */
  readonly refill: () => Promise<void>;
  /** True when the conversation belongs to a background task: tasks cannot spawn sub-tasks. */
  readonly isTaskConversation: (conversationId: string) => Effect.Effect<boolean, External>;
  /**
   * Wire the bot binder (and the limits and files lookups), resume
   * still-running tasks and start what the queue holds. Called once by the
   * entity after the profiles index exists, so no task turn runs unbound.
   */
  readonly attach: (binder: TaskBinder, wiring?: TaskWiring) => Promise<void>;
}

export class Tasks extends Context.Service<Tasks, TasksService>()("spriessen/mind/Tasks") {}

const TITLE_CHARS = 40;

const RESUME_NOTE =
  "[resume] You were interrupted by a server restart. Continue the task from where the " +
  "transcript left off and produce the final deliverable now. Before repeating anything " +
  "that reached outside (a message, a post, a booking, a change to files or a service), " +
  "check whether it already happened; never do it twice.";

/** Framing the task sees once, above its brief (the row keeps the raw prompt). */
export const TASK_BRIEF =
  "[task brief] You are a background task your bot started; your final reply is the result " +
  "it receives. Save deliverables (documents, data, images) as files with artifact_write: " +
  "they reach your bot as links. A [from parent] line is a new instruction from it: follow " +
  "it, also after you finished (your bot may continue you). For long work, post a one-line " +
  "milestone to your owner with notify_owner (rarely; never the result).";

/** Point a task's conversation at its own model before its first turn. */
const applyTaskModel = (
  converse: ConverseService,
  id: string,
  model: TaskModel,
): Effect.Effect<void, External> =>
  Effect.flatMap(converse.ensure(taskConversationKey(id)), (conversation) =>
    converse.configure(conversation, {
      model: model.id,
      effort: model.effort === "" ? null : (model.effort as ModelThinkingLevel),
    }),
  );

type SpawnInput = Parameters<TasksService["spawn"]>[0];

/** The stored row of a new task, before it is placed. */
const rowOf = (id: string, input: SpawnInput, bot: TaskBot | null): TaskInfo => {
  const title = input.title?.trim().slice(0, TITLE_CHARS) ?? "";
  return {
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
    ...(input.outside === true ? { outside: true } : {}),
    ...(input.model !== undefined ? { model: input.model.id } : {}),
    ...(input.model !== undefined && input.model.effort !== ""
      ? { effort: input.model.effort }
      : {}),
    ...(input.report === "note" ? { report: "note" as const } : {}),
    ...(input.lane === "owner" ? { lane: "owner" as const } : {}),
    ...(input.resultSchema !== undefined ? { resultSchema: input.resultSchema as Json } : {}),
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
  };
};

const spawnTask =
  (rt: TaskRuntime): TasksService["spawn"] =>
  (input) =>
    Effect.flatMap(
      Effect.tryPromise({
        // Bind, place and record under the lock: two spawns never both take
        // the last slot, and a refused spawn leaves no conversation behind.
        try: () =>
          rt.lock(async () => {
            const id = randomUUID();
            const probe = { id, conversationId: input.conversationId };
            const all = await Effect.runPromise(readTasks(rt.converse));
            // The conversation exists, with the bot's agent, and is indexed
            // under the bot before the task is admitted: the first turn
            // already runs as the bot.
            const bot = await bindTask(rt, id, input.conversationId, null);
            // At or over the daily token budget: refuse with a sentence the
            // model relays — queueing would only pile work for tomorrow. (The
            // just-bound conversation stays empty and row-less: invisible.)
            if (bot !== null) {
              const over = await overBudget(rt, bot);
              if (over !== undefined) {
                return { refused: budgetMessage(over.today, over.budget) };
              }
            }
            const placement = await placementOf(rt, all, { ...probe, ...(bot ? { bot } : {}) });
            if (placement === "full") return { full: true as const };
            if (input.model !== undefined) {
              await Effect.runPromise(applyTaskModel(rt.converse, id, input.model));
            }
            const format = input.resultSchema === undefined ? "" : schemaBrief(input.resultSchema);
            const brief = `${TASK_BRIEF}\n\n${input.prompt}${format}`;
            const row = rowOf(id, input, bot);
            const task: TaskInfo =
              placement === "running"
                ? { ...row, startedAt: row.createdAt }
                : { ...row, status: "queued", next: brief };
            await Effect.runPromise(writeTasks(rt.converse, [...all, task]));
            return { full: false as const, task, brief };
          }),
        catch: (cause) => new External({ op: "task spawn", cause }),
      }),
      (placed) => {
        if ("refused" in placed) return Effect.fail(new InvalidInput({ reason: placed.refused }));
        if (placed.full) return Effect.fail(new InvalidInput({ reason: queueFullMessage() }));
        if (placed.task.status === "running") runTask(rt, placed.task, placed.brief);
        return Effect.succeed(placed.task);
      },
    );

/**
 * Boot-time resume: the in-process runner dies with the old process, but the
 * task's transcript is durable. Rebind each still-running task to its bot
 * (from the row, else from the spawning chat), re-admit a continuation input
 * and re-attach a runner; queued tasks are rebound and wait for the pump. A
 * task that finished but whose parent was never woken (the crash hit in
 * between) wakes the parent now.
 */
const resumeRunning = async (rt: TaskRuntime): Promise<void> => {
  const tasks = await Effect.runPromise(readTasks(rt.converse));
  for (const task of tasks) {
    if (task.status === "running" || task.status === "queued") {
      const bot = await bindTask(rt, task.id, task.conversationId, task.bot ?? null);
      if (bot !== null && task.bot === undefined) {
        await Effect.runPromise(updateTask(rt.converse, task.id, (row) => ({ ...row, bot })));
      }
      if (task.status === "running")
        runTask(rt, bot !== null ? { ...task, bot } : task, RESUME_NOTE);
    } else if (task.notified === false) void wakeWithFiles(rt, task.id);
  }
  await rt.pump();
};

const taskOfConversation = async (
  rt: TaskRuntime,
  conversationId: string,
): Promise<TaskInfo | undefined> => {
  const { converse } = rt;
  const tasks = await Effect.runPromise(readTasks(converse));
  const known = rt.conversations.get(conversationId);
  if (known !== undefined) return tasks.find((task) => task.id === known);
  const ids = await Promise.all(
    tasks.map((task) => Effect.runPromise(converse.conversationIdOf(taskConversationKey(task.id)))),
  );
  const index = ids.findIndex((id) => id !== undefined && String(id) === conversationId);
  const task = tasks[index];
  if (task !== undefined) rt.conversations.set(conversationId, task.id);
  return task;
};

const removeTask =
  (rt: TaskRuntime): TasksService["remove"] =>
  (id) =>
    Effect.tryPromise({
      try: async () => {
        const task = await Effect.runPromise(findTask(rt.converse, id));
        if (task === undefined) return { removed: false, cancelled: false };
        const live = task.status === "running" || task.status === "queued";
        const cancelled = live ? await cancelTask(rt, id, false) : false;
        const tasks = await Effect.runPromise(readTasks(rt.converse));
        await Effect.runPromise(
          writeTasks(
            rt.converse,
            tasks.filter((candidate) => candidate.id !== id),
          ),
        );
        return { removed: true, cancelled };
      },
      catch: (cause) => new External({ op: "task remove", cause }),
    });

export const tasksService = (converse: ConverseService): TasksService => {
  const rt: TaskRuntime = {
    converse,
    binder: null,
    wiring: {},
    followers: new Map(),
    closing: new Set(),
    listeners: new Set(),
    conversations: new Map(),
    lock: serial(),
    pump: async () => undefined,
  };
  rt.pump = pumpQueue(rt);
  let attached = false;
  const taskOf = (conversationId: string) =>
    Effect.tryPromise({
      try: () => taskOfConversation(rt, conversationId),
      catch: (cause) => new External({ op: "task lookup", cause }),
    });
  return {
    spawn: spawnTask(rt),
    get: (id) => findTask(converse, id),
    list: () => readTasks(converse),
    cancel: (id, options) =>
      Effect.tryPromise({
        try: () => cancelTask(rt, id, options?.quiet === true),
        catch: (cause) => new External({ op: "task cancel", cause }),
      }),
    stopTree: (id) =>
      Effect.tryPromise({
        try: () => stopTaskTree(rt, id, false),
        catch: (cause) => new External({ op: "task stop tree", cause }),
      }),
    stopChatWork: (conversationId) =>
      Effect.tryPromise({
        try: () => stopChatWork(rt, conversationId),
        catch: (cause) => new External({ op: "chat work stop", cause }),
      }),
    message: messageTask(rt),
    steps: (id, count) => recentSteps(converse, id, count),
    remove: removeTask(rt),
    notify: (id, text) => notifyOwner(converse, id, text),
    listen: (fn) => {
      rt.listeners.add(fn);
      return () => void rt.listeners.delete(fn);
    },
    onUpdate: onTaskChange,
    taskOf,
    isTaskConversation: (conversationId) =>
      Effect.map(taskOf(conversationId), (task) => task !== undefined),
    laneOf: async (conversationId) => {
      const task = await taskOfConversation(rt, conversationId).catch(() => undefined);
      return task?.lane === "owner" ? "owner" : "background";
    },
    refill: () => rt.pump(),
    attach: async (binder, wiring) => {
      rt.binder = binder;
      if (wiring !== undefined) rt.wiring = wiring;
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
