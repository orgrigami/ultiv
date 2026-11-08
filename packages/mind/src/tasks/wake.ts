/**
 * Waking the conversation that spawned a task with its outcome — exactly once
 * per run: the row carries `notified: false` until the wake is admitted, and
 * the request id (the task id, plus the run number from a task's second run
 * on) makes a repeat (a racing runner, a re-wake after a restart) land only
 * once. The files the run wrote ride along as links, so the parent can hand
 * them over without opening any of them.
 */
import { Effect } from "effect";
import type { TaskInfo } from "@spriessen/contracts";
import type { ConverseService } from "../converse/converse.ts";
import { findTask, updateTask } from "./store.ts";

const WAKE_RESULT_CHARS = 4_000;

/** A file a task wrote: its artifact id and name. */
export type TaskFile = { readonly id: string; readonly name: string };

/** Files listed in one wake, at most; the rest are counted. */
const WAKE_FILES = 12;

/** The files block of a wake: markdown links the chat renders as file cards. */
export const filesBlockOf = (files: readonly TaskFile[]): string => {
  if (files.length === 0) return "";
  const shown = files.slice(0, WAKE_FILES).map((file) => {
    const name = file.name.replace(/[[\]\n]/g, " ").trim() || file.id;
    return `- [${name}](/api/artifacts/${file.id})`;
  });
  const more = files.length > WAKE_FILES ? [`- and ${files.length - WAKE_FILES} more`] : [];
  return `\n\nFiles (link them in your reply as written):\n${[...shown, ...more].join("\n")}`;
};

/** The error a queued task cancelled before its first run carries. */
export const NOT_STARTED = "cancelled before it started";

/** The entry kind a background task's report is placed as in its parent chat. */
export const TASK_REPORT_KIND = "ultiv.task-report";

/** A done task's result as the parent reads it: structured results as a JSON block. */
const resultTextOf = (task: TaskInfo): string => {
  const text = task.result ?? "";
  if (task.resultSchema === undefined) return text;
  if (task.structured === null || task.structured === undefined) {
    return `[the result did not match the requested format; raw reply below]\n\n${text}`;
  }
  return `\`\`\`json\n${JSON.stringify(task.structured, null, 2)}\n\`\`\``;
};

/** The wake text for a settled task, rebuilt from its registry row. */
export const wakeTextOf = (task: TaskInfo, files: readonly TaskFile[] = []): string | undefined => {
  const attached = filesBlockOf(files);
  switch (task.status) {
    case "done": {
      const text = resultTextOf(task);
      const digest =
        text.length > WAKE_RESULT_CHARS
          ? `${text.slice(0, WAKE_RESULT_CHARS)}\n[truncated; full result: task_status "${task.id}"]`
          : text;
      return `[task ${task.id} finished]\n\n${digest}${attached}`;
    }
    case "failed":
      return `[task ${task.id} failed] ${task.error ?? "unknown error"}${attached}`;
    case "cancelled":
      return task.error === NOT_STARTED
        ? `[task ${task.id} cancelled] stopped before it started.`
        : `[task ${task.id} cancelled] stopped before completion.${attached}`;
    default:
      return undefined;
  }
};

/** A settled task owes its parent a wake until `notified` flips back to true. */
export const owed = (current: TaskInfo): Partial<TaskInfo> =>
  current.conversationId === null ? {} : { notified: false };

/** The wake's request id: one per run, so a continued task's next result is not deduped away. */
export const wakeRequestId = (task: Pick<TaskInfo, "id" | "runs">): string =>
  (task.runs ?? 1) > 1 ? `task-wake:${task.id}:${task.runs}` : `task-wake:${task.id}`;

/** Submit the outcome into the spawning conversation once; best-effort, never throws. */
export const wakeParent = async (
  converse: ConverseService,
  id: string,
  files: readonly TaskFile[] = [],
): Promise<void> => {
  try {
    const task = await Effect.runPromise(findTask(converse, id));
    if (task === undefined || task.conversationId === null || task.notified !== false) return;
    const text = wakeTextOf(task, files);
    if (text === undefined) return;
    const parent = await Effect.runPromise(converse.open(task.conversationId));
    if (parent === undefined) return;
    if (task.report === "note") {
      // A background report: the chat shows it and the bot reads it with its
      // next turn, but no turn starts for it.
      await Effect.runPromise(converse.note(parent, TASK_REPORT_KIND, { taskId: id }, text));
      await Effect.runPromise(
        updateTask(converse, id, (current) => ({ ...current, notified: true })),
      );
      return;
    }
    const submission = await Effect.runPromise(
      converse.submit(parent, text, undefined, wakeRequestId(task)),
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
