/**
 * One task's activity while its sheet is open: steps, files and any approval
 * waiting on it. Live signals drive the refresh (a task row change or a
 * publication in the task's conversation), and window focus covers a
 * sleeping tab. Settled tasks load once and stop.
 */
import { useCallback, useEffect, useState } from "react";
import type { TaskInfo } from "@spriessen/contracts";
import { api, type ArtifactRow, type TaskActivity } from "@/lib/api";
import { onLive } from "@/lib/live.ts";

export function useTaskActivity(task: TaskInfo, open: boolean) {
  const [activity, setActivity] = useState<TaskActivity | null>(null);
  const [files, setFiles] = useState<ArtifactRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await api.taskActivity(task.id);
      setActivity(next);
      setFiles(next.conversationId !== null ? await api.artifactsFor(next.conversationId) : []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [task.id]);

  const running = task.status === "running";
  useEffect(() => {
    if (!open) return;
    void load();
    // Pushed signals replace the poll; focus still covers a sleeping tab.
    return onLive((kind) => {
      if (running && (kind === "tasks" || kind === "approvals" || kind === "sync")) void load();
    });
  }, [open, load, running]);

  const decide = async (approved: boolean, always?: boolean, takeover?: boolean) => {
    const conversationId = activity?.conversationId;
    const callId = activity?.waiting?.callId;
    if (conversationId === null || conversationId === undefined || callId === undefined) return;
    // A failure throws into the card, which keeps it visible for a retry.
    const result = await api.approvalDecide(conversationId, callId, approved, always, takeover);
    await load();
    return { stored: result.stored };
  };

  return { activity, files, error, load, decide };
}
