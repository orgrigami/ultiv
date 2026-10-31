/**
 * Pushes live task progress: while a task runs, its conversation's committed
 * publications (tool calls, replies) are watched through the same in-process
 * view the chat Session uses, and every change is a coarse "tasks" signal on
 * the live socket. Row changes (spawn, settle, progress lines) come from the
 * tasks faculty's onUpdate. No polling.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { taskConversationKey, type MindService } from "@spriessen/mind";
import { Effect } from "effect";

export interface TaskWatcher {
  readonly stop: () => void;
}

/** Watch every running task's conversation; re-reconcile on any row change. */
export const watchRunningTasks = (mind: MindService, signal: () => void): TaskWatcher => {
  const watching = new Map<string, () => void>();

  const attach = async (taskId: string): Promise<void> => {
    try {
      const conversation = await Effect.runPromise(
        mind.converse.ensure(taskConversationKey(taskId)),
      );
      const view = await conversation.viewState(BACKGROUND_CONTEXT);
      if (view === undefined) return;
      const unsubscribe = view.subscribe(() => signal());
      watching.set(taskId, () => {
        unsubscribe();
        watching.delete(taskId);
      });
      // Already settled between the list read and the attach: let go.
      const rows = await Effect.runPromise(mind.tasks.list());
      const row = rows.find((candidate) => candidate.id === taskId);
      if (row === undefined || row.status !== "running") detach(taskId);
    } catch {
      // A conversation that will not open yet simply is not watched; the
      // next row change reconciles again.
    }
  };

  const detach = (taskId: string): void => {
    watching.get(taskId)?.();
  };

  const reconcile = async (): Promise<void> => {
    signal();
    const rows = await Effect.runPromise(mind.tasks.list());
    const running = new Set(rows.filter((row) => row.status === "running").map((row) => row.id));
    for (const id of running) if (!watching.has(id)) void attach(id);
    for (const id of [...watching.keys()]) if (!running.has(id)) detach(id);
  };

  const off = mind.tasks.onUpdate(() => void reconcile());
  void reconcile();
  return {
    stop: () => {
      off();
      for (const id of [...watching.keys()]) detach(id);
    },
  };
};
