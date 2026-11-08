/**
 * This chat's background tasks, refreshed by the `tasks` live signal. One
 * list feeds the header's task chip, the live task lines and task cards in
 * the transcript, and the Stop confirmation.
 * Nothing shows until the chat's conversation id is known, so tasks from
 * other chats never leak in.
 */
import { useCallback, useEffect, useState } from "react";
import type { TaskRow } from "@spriessen/contracts";
import { api } from "@/lib/api";
import { onLive } from "@/lib/live.ts";
import { pollFailed, pollRecovered } from "@/lib/notify";
import { isLive } from "@/lib/task-text";

export interface ChatTasks {
  readonly tasks: readonly TaskRow[];
  /** Running or queued: what Stop would also stop. */
  readonly live: readonly TaskRow[];
  readonly refresh: () => Promise<void>;
}

export function useTasks(conversationId: string | null): ChatTasks {
  const [tasks, setTasks] = useState<TaskRow[]>([]);

  const refresh = useCallback(async () => {
    if (conversationId === null) return;
    try {
      const all = await api.tasks();
      setTasks(all.filter((task) => task.conversationId === conversationId));
      pollRecovered("tasks-poll");
    } catch (cause) {
      // Keep the last known list, but say it may be stale (one toast, not one per poll).
      pollFailed("tasks-poll", "Background tasks may be out of date", cause);
    }
  }, [conversationId]);

  useEffect(() => {
    setTasks([]);
    void refresh();
    // Pushed signals replace the poll; focus still covers a sleeping tab.
    const off = onLive((kind) => {
      if (kind === "tasks" || kind === "sync") void refresh();
    });
    const onFocus = (): void => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      off();
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const live = tasks.filter(isLive);
  return { tasks: conversationId === null ? [] : tasks, live, refresh };
}
