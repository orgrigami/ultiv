/** The task registry doc and its read/write helpers, shared by the faculty's parts. */
import { defineDoc } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import type { External } from "@spreissen/core";
import type { TaskInfo } from "@spreissen/contracts";
import type { ConverseService } from "../converse/converse.ts";

/** The registry doc; exported for tests and read-only surfaces. */
export const TasksDoc = defineDoc<{ tasks: TaskInfo[] }>({
  kind: "ultiv.tasks",
  version: 1,
  scope: "session",
  initial: () => ({ tasks: [] }),
  checkpointWhen: () => true,
});

export const taskConversationKey = (id: string): string => `task:${id}`;

/** Legacy rows predate `conversationId`; normalize on every read. */
const normalize = (task: TaskInfo): TaskInfo => ({
  ...task,
  conversationId: task.conversationId ?? null,
});

export const readTasks = (converse: ConverseService): Effect.Effect<TaskInfo[], External> =>
  Effect.map(converse.docs.snapshot(TasksDoc), (doc) => (doc?.tasks ?? []).map(normalize));

export const writeTasks = (
  converse: ConverseService,
  tasks: TaskInfo[],
): Effect.Effect<void, External> =>
  converse.docs.commit(async (tx) => {
    const draft = await tx.doc(TasksDoc);
    draft.tasks = tasks;
  });

/** Read-modify-write of one row inside a single commit (no lost updates between rows). */
export const updateTask = (
  converse: ConverseService,
  id: string,
  change: (task: TaskInfo) => TaskInfo,
): Effect.Effect<void, External> =>
  converse.docs.commit(async (tx) => {
    const draft = await tx.doc(TasksDoc);
    draft.tasks = draft.tasks.map((task) => (task.id === id ? change(normalize(task)) : task));
  });

export const findTask = (
  converse: ConverseService,
  id: string,
): Effect.Effect<TaskInfo | undefined, External> =>
  Effect.map(readTasks(converse), (tasks) => tasks.find((task) => task.id === id));

/** A short display title: the bot's own, else the first line of the brief, ≤40 chars. */
export const titleOf = (task: Pick<TaskInfo, "title" | "prompt">): string => {
  const own = task.title?.trim() ?? "";
  const source = own !== "" ? own : (task.prompt.split("\n")[0] ?? "").trim();
  return source.length > 40 ? `${source.slice(0, 39).trimEnd()}…` : source;
};
