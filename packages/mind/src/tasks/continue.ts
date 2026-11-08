/**
 * Talking to a task after it was spawned. A RUNNING task is steered (the text
 * lands at its next step, like the owner steering a chat); a QUEUED one gets
 * the text added to the input it starts with; a SETTLED one (done, failed or
 * cancelled) is CONTINUED: it runs again in its own conversation, with the
 * whole of its earlier work in context, and wakes its parent again when this
 * run settles. A continuation takes a slot like a spawn: it may queue.
 */
import { Effect } from "effect";
import { External } from "@spriessen/core";
import type { TaskInfo } from "@spriessen/contracts";
import { findTask, readTasks, taskConversationKey, updateTask } from "./store.ts";
import { placementOf } from "./queue.ts";
import { runTask, type TaskRuntime } from "./run.ts";

/** The wake prefix a parent bot's task_message arrives under, in the task's chat. */
export const FROM_PARENT = "[from parent]";

/**
 * What became of a message: steered into the run ("sent"), added to a queued
 * task's input ("sent"), a settled task running again ("continued") or
 * waiting for a slot to do so ("queued"); refused while a run is reporting
 * ("finishing"), with a full queue ("full"), or for an unknown task.
 */
export type MessageOutcome = "sent" | "continued" | "queued" | "finishing" | "full" | "unknown";

export interface MessageOptions {
  /** The steering turn had outside content: the row is marked for good. */
  readonly outside?: boolean;
  /** The owner's own message asked for this: the run rides the owner lane. */
  readonly lane?: "owner";
}

const marks = (options: MessageOptions | undefined): Partial<TaskInfo> => ({
  ...(options?.outside === true ? { outside: true } : {}),
  ...(options?.lane === "owner" ? { lane: "owner" as const } : {}),
});

/** A settled row starting its next run (running now, or queued with its input). */
const nextRun = (
  task: TaskInfo,
  placement: "running" | "queued",
  input: string,
  options: MessageOptions | undefined,
): TaskInfo => {
  const {
    structured: _structured,
    notified: _notified,
    next: _next,
    startedAt: _startedAt,
    ...rest
  } = task;
  return {
    ...rest,
    ...marks(options),
    status: placement,
    result: null,
    error: null,
    finishedAt: null,
    runs: (task.runs ?? 1) + 1,
    ...(placement === "running" ? { startedAt: Date.now() } : { next: input }),
  };
};

/** Steer a running task: the text lands at its next step. */
const steer = async (rt: TaskRuntime, task: TaskInfo, input: string, options?: MessageOptions) => {
  const extra = marks(options);
  // Marked before the text lands, so the steered step already counts as outside.
  if (Object.keys(extra).length > 0) {
    await Effect.runPromise(updateTask(rt.converse, task.id, (row) => ({ ...row, ...extra })));
  }
  const conversation = await Effect.runPromise(rt.converse.ensure(taskConversationKey(task.id)));
  const submission = await Effect.runPromise(rt.converse.submit(conversation, input, "steer"));
  rt.followers.set(task.id, [...(rt.followers.get(task.id) ?? []), submission]);
};

/** Continue a settled task, under the lock: place it, then start it outside. */
const resume = async (
  rt: TaskRuntime,
  id: string,
  input: string,
  options: MessageOptions | undefined,
): Promise<MessageOutcome> => {
  const placed = await rt.lock(async () => {
    const all = await Effect.runPromise(readTasks(rt.converse));
    const task = all.find((row) => row.id === id);
    if (task === undefined) return { outcome: "unknown" as const };
    if (task.status === "running" || task.status === "queued") return { outcome: "busy" as const };
    const placement = await placementOf(rt, all, task);
    if (placement === "full") return { outcome: "full" as const };
    const next = nextRun(task, placement, input, options);
    await Effect.runPromise(updateTask(rt.converse, id, () => next));
    return { outcome: placement, task: next };
  });
  if (placed.outcome === "busy") return "finishing";
  if (placed.outcome !== "running") return placed.outcome;
  runTask(rt, placed.task, input);
  return "continued";
};

/** Add the text to a queued task's input; false when it left the queue meanwhile. */
const addToQueued = (
  rt: TaskRuntime,
  id: string,
  input: string,
  options: MessageOptions | undefined,
): Promise<boolean> =>
  rt.lock(async () => {
    const row = await Effect.runPromise(findTask(rt.converse, id));
    if (row?.status !== "queued") return false;
    await Effect.runPromise(
      updateTask(rt.converse, id, (current) => ({
        ...current,
        ...marks(options),
        next: `${current.next ?? ""}\n\n${input}`.trim(),
      })),
    );
    return true;
  });

const deliver = async (
  rt: TaskRuntime,
  id: string,
  input: string,
  options: MessageOptions | undefined,
): Promise<MessageOutcome> => {
  // Two passes: a queued task may start between the read and the write.
  for (let pass = 0; pass < 2; pass += 1) {
    const task = await Effect.runPromise(findTask(rt.converse, id));
    if (task === undefined) return "unknown";
    if (task.status === "running") {
      if (rt.closing.has(id)) return "finishing";
      await steer(rt, task, input, options);
      return "sent";
    }
    if (task.status !== "queued") return resume(rt, id, input, options);
    if (await addToQueued(rt, id, input, options)) return "sent";
  }
  return "finishing";
};

export const messageTask =
  (rt: TaskRuntime) =>
  (id: string, text: string, options?: MessageOptions): Effect.Effect<MessageOutcome, External> =>
    Effect.tryPromise({
      try: () => deliver(rt, id, `${FROM_PARENT} ${text}`, options),
      catch: (cause) => new External({ op: "task message", cause }),
    });
