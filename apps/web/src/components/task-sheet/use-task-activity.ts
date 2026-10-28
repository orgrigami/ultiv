/**
 * One task's activity while its sheet is open: steps, files and any approval
 * waiting on it. Polls (REST has no push); cheap because the endpoint returns
 * a size-capped tail. Settled tasks stop polling once loaded.
 */
import { useCallback, useEffect, useState } from "react";
import type { TaskInfo } from "@ultiv/contracts";
import { api, type ArtifactRow, type TaskActivity } from "@/lib/api";

const POLL_MS = 2_500;

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
    if (!running) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
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
