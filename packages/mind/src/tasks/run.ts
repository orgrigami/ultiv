/**
 * Running one task: binding its conversation to its bot, settling a run in
 * the background (with the parent messages that arrived meanwhile) and
 * reporting the outcome. The queue (queue.ts) decides WHEN a run starts;
 * this module only runs it.
 */
import type { Conversation, Submission } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { ownerErrorText } from "@spriessen/core";
import type { TaskInfo } from "@spriessen/contracts";
import type { ConverseService } from "../converse/converse.ts";
import { findTask, taskConversationKey, updateTask } from "./store.ts";
import { settleStructured } from "./structured.ts";
import { owed, wakeParent, type TaskFile } from "./wake.ts";

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

/** What the entity wires in once profiles and artifacts exist (attach). */
export interface TaskWiring {
  /** The bot's running limit (limits.ts); absent: the workspace default. */
  readonly limitOf?: (bot: TaskBot | null) => Promise<number>;
  /** Files a task's conversation wrote since a time, for the parent's wake. */
  readonly filesOf?: (conversationId: string, since: number) => Promise<readonly TaskFile[]>;
}

/** Mutable wiring shared by the service's parts. */
export interface TaskRuntime {
  readonly converse: ConverseService;
  binder: TaskBinder | null;
  wiring: TaskWiring;
  /** Parent messages admitted into a running task, settled before it reports. */
  readonly followers: Map<string, Submission[]>;
  /** Tasks past their last drain: new messages are refused, not lost. */
  readonly closing: Set<string>;
  /** Hear a task settle (done or failed; never a cancel). */
  readonly listeners: Set<(task: TaskInfo) => void>;
  /** Task conversation id → task id, filled as tasks bind (lanes read it per request). */
  readonly conversations: Map<string, string>;
  /** Serializes admission decisions: two spawns never both take the last slot. */
  readonly lock: <A>(fn: () => Promise<A>) => Promise<A>;
  /** Start queued work that now fits; set by the queue (queue.ts). */
  pump: () => Promise<void>;
}

/** A promise chain: each call runs after the previous one settled. */
export const serial = (): TaskRuntime["lock"] => {
  let tail: Promise<unknown> = Promise.resolve();
  return <A>(fn: () => Promise<A>): Promise<A> => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => undefined);
    return next;
  };
};

/** Ensure and bind the task's conversation before any turn reaches it. */
export const bindTask = async (
  rt: TaskRuntime,
  id: string,
  parent: string | null,
  stored: TaskBot | null,
): Promise<TaskBot | null> => {
  const key = taskConversationKey(id);
  const bot = rt.binder === null ? null : await rt.binder(key, parent, stored).catch(() => null);
  // Unbound (no bot, or the binder failed): the conversation still exists.
  if (bot === null) await Effect.runPromise(rt.converse.ensure(key));
  const cid = await Effect.runPromise(rt.converse.conversationIdOf(key)).catch(() => undefined);
  if (cid !== undefined) rt.conversations.set(String(cid), id);
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

/** The parent's wake for a settled task: with the files this run wrote. */
export const wakeWithFiles = async (rt: TaskRuntime, id: string): Promise<void> => {
  const task = await Effect.runPromise(findTask(rt.converse, id)).catch(() => undefined);
  if (task === undefined) return;
  const cid = await Effect.runPromise(rt.converse.conversationIdOf(taskConversationKey(id))).catch(
    () => undefined,
  );
  const since = task.startedAt ?? task.createdAt;
  const files =
    cid === undefined || rt.wiring.filesOf === undefined
      ? []
      : await rt.wiring.filesOf(String(cid), since).catch(() => []);
  await wakeParent(rt.converse, id, files);
};

/** The settled row's fields for a finished run (done), unless it was cancelled meanwhile. */
const finishRun = async (
  rt: TaskRuntime,
  task: TaskInfo,
  conversation: Conversation,
  text: string,
): Promise<void> => {
  const shaped =
    task.resultSchema === undefined
      ? undefined
      : await settleStructured(rt.converse, conversation, task.resultSchema, text);
  const result = shaped?.result ?? text;
  await Effect.runPromise(
    updateTask(rt.converse, task.id, (current) =>
      current.status === "cancelled"
        ? current
        : {
            ...current,
            status: "done",
            result,
            ...(shaped !== undefined ? { structured: shaped.structured } : {}),
            finishedAt: Date.now(),
            ...owed(current),
          },
    ),
  );
};

/**
 * Settles one run of a task in the background: the registry doc carries the
 * outcome, the spawning conversation is woken with it, and the queue gets
 * the freed slot. A cancellation wins over both outcomes: once the doc says
 * "cancelled", the runner keeps its hands off.
 */
export const runTask = (rt: TaskRuntime, task: TaskInfo, input: string): void => {
  const { converse } = rt;
  void (async () => {
    try {
      const conversation = await Effect.runPromise(converse.ensure(taskConversationKey(task.id)));
      const first = await Effect.runPromise(converse.turn(conversation, input));
      const text = await drainFollowers(rt, task.id, conversation, first.text);
      await finishRun(rt, task, conversation, text);
    } catch (cause) {
      // The owner reads this in Needs you: a sentence, not the bare tag
      // ("spriessen/External"). The full cause goes to the server log.
      console.error(`task ${task.id} failed:`, cause);
      const error = ownerErrorText(cause).slice(0, 500);
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
    await wakeWithFiles(rt, task.id);
    await rt.pump().catch((cause) => console.error("task queue failed:", cause));
  })();
};
