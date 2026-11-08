/**
 * A task drawn live where it was started or messaged in the chat: the shared
 * task line, updated by the chat's task list. Nothing when the chat does not
 * know the task (removed, or another chat's).
 */
import { TaskLine } from "@/components/task-row";
import { useChatTasks } from "@/lib/chat-tasks";
import { isLive } from "@/lib/task-text";
import { useNow } from "@/lib/use-now";

export function LiveTask({ id, className }: { id: string; className?: string | undefined }) {
  const chat = useChatTasks();
  const task = chat?.tasks.find((candidate) => candidate.id === id);
  const now = useNow(1_000, task !== undefined && isLive(task));
  if (chat === null || task === undefined) return null;
  return (
    <TaskLine task={task} now={now} onChanged={() => void chat.refresh()} className={className} />
  );
}
