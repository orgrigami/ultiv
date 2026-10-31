/**
 * Waking the conversation that spawned a task with its outcome — exactly once:
 * the row carries `notified: false` until the wake is admitted, and the
 * request id makes a repeat (a racing runner, a re-wake after a restart) land
 * only once.
 */
import { Effect } from "effect";
import type { TaskInfo } from "@spreissen/contracts";
import type { ConverseService } from "../converse/converse.ts";
import { findTask, updateTask } from "./store.ts";

const WAKE_RESULT_CHARS = 4_000;

/** The wake text for a settled task, rebuilt from its registry row. */
export const wakeTextOf = (task: TaskInfo): string | undefined => {
  switch (task.status) {
    case "done": {
      const text = task.result ?? "";
      const digest =
        text.length > WAKE_RESULT_CHARS
          ? `${text.slice(0, WAKE_RESULT_CHARS)}\n[truncated — full result: task_status "${task.id}"]`
          : text;
      return `[task ${task.id} finished]\n\n${digest}`;
    }
    case "failed":
      return `[task ${task.id} failed] ${task.error ?? "unknown error"}`;
    case "cancelled":
      return `[task ${task.id} cancelled] stopped before completion.`;
    default:
      return undefined;
  }
};

/** A settled task owes its parent a wake until `notified` flips back to true. */
export const owed = (current: TaskInfo): Partial<TaskInfo> =>
  current.conversationId === null ? {} : { notified: false };

/** Submit the outcome into the spawning conversation once; best-effort, never throws. */
export const wakeParent = async (converse: ConverseService, id: string): Promise<void> => {
  try {
    const task = await Effect.runPromise(findTask(converse, id));
    if (task === undefined || task.conversationId === null || task.notified !== false) return;
    const text = wakeTextOf(task);
    if (text === undefined) return;
    const parent = await Effect.runPromise(converse.open(task.conversationId));
    if (parent === undefined) return;
    const submission = await Effect.runPromise(
      converse.submit(parent, text, undefined, `task-wake:${id}`),
    );
    await Effect.runPromise(
      updateTask(converse, id, (current) => ({ ...current, notified: true })),
    );
    void Effect.runPromise(converse.settle(parent, submission)).catch((cause) => {
      console.error("wake turn failed:", cause);
    });
  } catch (cause) {
    console.error("task wake failed:", cause);
  }
};
