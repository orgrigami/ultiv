/**
 * Stop propagation: a Stop (the task pill's, or a chat's) travels down the
 * work tree. The tree of a TASK is its own conversation — the subrequests it
 * sent (mailbox envelopes still pending) and the background bash jobs it
 * started; tasks cannot spawn sub-tasks, so the graph is one level deep. The
 * tree of a CHAT is every task it spawned plus those trees.
 *
 * Order matters, and it is ROOT FIRST: the task row turns "cancelled" (its
 * conversation aborted) before any mailbox NACK or job end could reach it —
 * a still-running turn that receives "cancelled, do not retry" mid-flight
 * can react by respawning the very work being stopped. Settled envelopes
 * never wake the stopped conversation again (delivery.ts `cancelSentFrom`
 * marks the sender notified), and killed jobs are cleared silently
 * (`BashJobHost.stopped`), so nothing downstream starts a new turn on work
 * the owner stopped. Everything is idempotent: a second Stop on the same
 * tree finds nothing left to settle.
 */
import { Effect } from "effect";
import type { TaskInfo } from "@spriessen/contracts";
import { cancelTask, type TaskRuntime } from "./run.ts";
import { findTask, readTasks, taskConversationKey } from "./store.ts";

/** What one Stop reached: tasks cancelled, messages settled, jobs killed. */
export interface TreeStop {
  readonly tasks: number;
  readonly messages: number;
  readonly jobs: number;
}

const zero = (): TreeStop => ({ tasks: 0, messages: 0, jobs: 0 });

const conversationOf = async (rt: TaskRuntime, taskId: string): Promise<string | undefined> => {
  const cid = await Effect.runPromise(
    rt.converse.conversationIdOf(taskConversationKey(taskId)),
  ).catch(() => undefined);
  return cid === undefined ? undefined : String(cid);
};

/** Settle what the tree's conversations left outstanding: mail out, jobs running. */
const stopExtras = async (rt: TaskRuntime, conversations: readonly string[]): Promise<TreeStop> => {
  const messages =
    rt.wiring.cancelMailSentFrom === undefined
      ? 0
      : await rt.wiring.cancelMailSentFrom(conversations).catch((cause: unknown) => {
          console.error("work-tree message cancel failed:", cause);
          return 0;
        });
  const jobs =
    rt.wiring.stopJobsOf === undefined
      ? 0
      : await rt.wiring.stopJobsOf(conversations).catch((cause: unknown) => {
          console.error("work-tree job stop failed:", cause);
          return 0;
        });
  return { tasks: 0, messages, jobs };
};

/**
 * Stop one task WITH its tree: the task itself first (abort + cancelled row,
 * exactly `cancel`), then the mail its conversation sent and the background
 * jobs it started. Undefined when the task was not live (nothing to stop).
 */
export const stopTaskTree = async (
  rt: TaskRuntime,
  id: string,
  quiet: boolean,
): Promise<TreeStop | undefined> => {
  const task = await Effect.runPromise(findTask(rt.converse, id));
  if (task === undefined || (task.status !== "running" && task.status !== "queued")) {
    return undefined;
  }
  if (!(await cancelTask(rt, id, quiet))) return zero();
  const conversation = await conversationOf(rt, id);
  const extras = await stopExtras(rt, conversation === undefined ? [] : [conversation]);
  return { ...extras, tasks: 1 };
};

/**
 * Stop a chat's whole work tree (its Stop button): every queued task first
 * (a freed slot must never start one), then the running ones, then each
 * tree's mail and jobs. The chat's own turn is aborted by the caller (the
 * session's interrupt) before this runs.
 */
export const stopChatWork = async (rt: TaskRuntime, conversationId: string): Promise<TreeStop> => {
  const tasks = (await Effect.runPromise(readTasks(rt.converse))).filter(
    (task: TaskInfo) =>
      task.conversationId === conversationId &&
      (task.status === "running" || task.status === "queued"),
  );
  const order = [
    ...tasks.filter((task) => task.status === "queued"),
    ...tasks.filter((task) => task.status === "running"),
  ];
  const conversations: string[] = [];
  let count = 0;
  for (const task of order) {
    if (await cancelTask(rt, task.id, true)) count += 1;
    const cid = await conversationOf(rt, task.id);
    if (cid !== undefined) conversations.push(cid);
  }
  return { ...(await stopExtras(rt, conversations)), tasks: count };
};
