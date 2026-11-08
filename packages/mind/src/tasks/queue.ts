/**
 * The task queue: a bot runs at most its limit of tasks at once (limits.ts);
 * the rest wait as "queued" rows and start, oldest first, as slots free. A
 * slot frees when a run settles, is cancelled or removed, and when the limit
 * is raised (`refill`). Every decision runs under the runtime's lock, so two
 * spawns never both take the last slot.
 */
import { Effect } from "effect";
import type { TaskInfo } from "@spriessen/contracts";
import { readTasks, updateTask } from "./store.ts";
import { MAX_QUEUED_TASKS, taskLimitOf } from "./limits.ts";
import { runTask, type TaskBot, type TaskRuntime } from "./run.ts";

/** The slot a task counts against: its bot, else the conversation that spawned it. */
export const slotKeyOf = (task: Pick<TaskInfo, "id" | "bot" | "conversationId">): string =>
  task.bot !== undefined
    ? `bot:${task.bot.owner}/${task.bot.profileId}`
    : task.conversationId !== null
      ? `chat:${task.conversationId}`
      : `task:${task.id}`;

const limitFor = async (rt: TaskRuntime, bot: TaskBot | null): Promise<number> =>
  rt.wiring.limitOf === undefined
    ? taskLimitOf(null, null)
    : await rt.wiring.limitOf(bot).catch(() => taskLimitOf(null, null));

/** The global pause (Settings › Pause the crew); a wiring gap reads "not paused". */
const pausedNow = async (rt: TaskRuntime): Promise<boolean> =>
  rt.wiring.isPaused === undefined ? false : await rt.wiring.isPaused().catch(() => false);

/** Where a new or continued run goes: start now, wait, or (a full queue) nowhere. */
export type Placement = "running" | "queued" | "full";

/** Place one task among the rest (call under the lock, with a fresh read). */
export const placementOf = async (
  rt: TaskRuntime,
  all: readonly TaskInfo[],
  task: Pick<TaskInfo, "id" | "bot" | "conversationId">,
): Promise<Placement> => {
  const key = slotKeyOf(task);
  const same = all.filter((other) => other.id !== task.id && slotKeyOf(other) === key);
  // Paused: nothing starts. The row queues like any other wait (or, past the
  // queue cap, the spawn is refused); resuming pumps what fits.
  if (await pausedNow(rt)) {
    const queued = same.filter((other) => other.status === "queued").length;
    return queued >= MAX_QUEUED_TASKS ? "full" : "queued";
  }
  const running = same.filter((other) => other.status === "running").length;
  if (running < (await limitFor(rt, task.bot ?? null))) return "running";
  const queued = same.filter((other) => other.status === "queued").length;
  return queued >= MAX_QUEUED_TASKS ? "full" : "queued";
};

/** The refusal a spawn or continuation gets when the bot's queue is full. */
export const queueFullMessage = (limit: number = MAX_QUEUED_TASKS): string =>
  `Your task queue is full (${limit} waiting). Wait for some to finish, or cancel ones you ` +
  "no longer need with task_cancel.";

/** A queued row taking its slot: running from now, its waiting input cleared. */
const started = (task: TaskInfo, at: number): TaskInfo => {
  const { next: _next, ...rest } = task;
  return { ...rest, status: "running", startedAt: at };
};

/** Start the queued tasks that fit, oldest first, per bot. */
export const pumpQueue = (rt: TaskRuntime) => async (): Promise<void> => {
  const starts = await rt.lock(async () => {
    if (await pausedNow(rt)) return [];
    const all = await Effect.runPromise(readTasks(rt.converse));
    const waiting = all
      .filter((task) => task.status === "queued")
      .toSorted((a, b) => a.createdAt - b.createdAt);
    if (waiting.length === 0) return [];
    const running = new Map<string, number>();
    for (const task of all) {
      if (task.status !== "running") continue;
      const key = slotKeyOf(task);
      running.set(key, (running.get(key) ?? 0) + 1);
    }
    const out: { readonly task: TaskInfo; readonly input: string }[] = [];
    for (const task of waiting) {
      const key = slotKeyOf(task);
      if ((running.get(key) ?? 0) >= (await limitFor(rt, task.bot ?? null))) continue;
      running.set(key, (running.get(key) ?? 0) + 1);
      const at = Date.now();
      await Effect.runPromise(
        updateTask(rt.converse, task.id, (current) =>
          current.status === "queued" ? started(current, at) : current,
        ),
      );
      out.push({ task: started(task, at), input: task.next ?? "" });
    }
    return out;
  });
  for (const { task, input } of starts) runTask(rt, task, input);
};
