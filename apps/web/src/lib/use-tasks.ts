/**
 * This chat's background tasks, polled (REST has no push). One poll feeds the
 * task pill, the task cards in the transcript and the Stop confirmation.
 * Nothing shows until the chat's conversation id is known, so tasks from
 * other chats never leak in.
 */
import { useCallback, useEffect, useState } from "react";
import type { TaskRow } from "@ultiv/contracts";
import { api } from "@/lib/api";
import { pollFailed, pollRecovered } from "@/lib/notify";

const POLL_MS = 3_000;

export interface ChatTasks {
  readonly tasks: readonly TaskRow[];
  readonly running: readonly TaskRow[];
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
    const timer = setInterval(() => void refresh(), POLL_MS);
    const onFocus = (): void => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const running = tasks.filter((task) => task.status === "running");
  return { tasks: conversationId === null ? [] : tasks, running, refresh };
}
