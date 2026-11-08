/**
 * Gates waiting on this chat's background tasks: each shows as a card in the
 * chat, and deciding one routes over REST to the task's own conversation.
 */
import type { TaskRow } from "@spriessen/contracts";
import type { TaskApproval } from "@/components/session-view";
import { api } from "@/lib/api";
import type { ChatTasks } from "@/lib/use-tasks";

export function useTaskApprovals(chatTasks: ChatTasks) {
  // A task's waiting gate popped into this thread: decide routes REST to the
  // task's own conversation, then the tasks poll refreshes the card away.
  const taskApprovals: TaskApproval[] = chatTasks.tasks.flatMap((task) => {
    const waiting = task.waitingApproval;
    const conversationId = task.taskConversationId;
    if (waiting === undefined || conversationId === null || conversationId === undefined) return [];
    return [{ task, ...waiting }];
  });
  const taskDecide = async (
    task: TaskRow,
    approved: boolean,
    always?: boolean,
    takeover?: boolean,
    input?: unknown,
  ): Promise<{ stored: number | null }> => {
    const conversationId = task.taskConversationId;
    const callId = task.waitingApproval?.callId;
    if (conversationId === undefined || conversationId === null || callId === undefined) {
      // The poll refreshed the row away mid-click: say so instead of dying
      // silently — the next poll removes the card either way.
      throw new Error("That approval is no longer waiting — the task moved on.");
    }
    // A failure throws into the card, which keeps it visible for a retry.
    const result = await api.approvalDecide(
      conversationId,
      callId,
      approved,
      always,
      takeover,
      input,
    );
    await chatTasks.refresh();
    return { stored: result.stored };
  };
  return { taskApprovals, taskDecide };
}
