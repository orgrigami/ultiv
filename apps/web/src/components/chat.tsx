/**
 * The chat area of one session: live session wiring, the conversation's
 * background tasks, and the full SessionView. Shared by the home screen (the
 * active bot's main chat) and the /sessions/$id page.
 */
import type { ChatBot } from "@/components/chat-header";
import { SessionView } from "@/components/session-view";
import { TasksPill } from "@/components/tasks-pill";
import { StopDialog } from "@/components/stop-dialog";
import { api } from "@/lib/api";
import { useApp } from "@/lib/app-state";
import { useSession } from "@/lib/use-session";
import { useTasks } from "@/lib/use-tasks";
import { useJevNotices } from "@/lib/use-jev-notices";
import { useState } from "react";
import type { ModelInfo, ProfileApprovalMode, ProfileInfo, TaskRow } from "@ultiv/contracts";
import type { TaskApproval } from "@/components/session-view";

/** The chat's bot carries the policies the header popover switches. */
type ChatBotWithPolicies = ChatBot & { policies?: ProfileInfo["policies"] };

export function Chat({
  sessionId,
  models,
  bot,
  onBack,
}: {
  sessionId: string;
  models: ModelInfo[];
  bot?: ChatBotWithPolicies | undefined;
  onBack?: (() => void) | undefined;
}) {
  const session = useSession(sessionId);
  const chatTasks = useTasks(session.conversationId);
  const jevNotices = useJevNotices(session.conversationId, session.transcript);
  const { refreshAll } = useApp();
  const [askStop, setAskStop] = useState(false);
  // Stop asks first only when this chat has background tasks running.
  const requestStop = async (): Promise<void> => {
    if (chatTasks.running.length === 0) await session.interrupt();
    else setAskStop(true);
  };
  // The approval-mode switch PATCHes just the one policy key and refreshes
  // the app state, like every other profile mutation.
  const changeApprovalMode = async (mode: ProfileApprovalMode): Promise<void> => {
    if (bot?.id === undefined) return;
    await api.updateProfile(bot.id, { policies: { approvalMode: mode } });
    await refreshAll();
  };
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
  ): Promise<void> => {
    const conversationId = task.taskConversationId;
    const callId = task.waitingApproval?.callId;
    if (conversationId === undefined || conversationId === null || callId === undefined) return;
    // A failure throws into the card, which keeps it visible for a retry.
    await api.approvalDecide(conversationId, callId, approved, always, takeover);
    await chatTasks.refresh();
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SessionView
        tasks={<TasksPill chatTasks={chatTasks} />}
        taskInfo={chatTasks.tasks}
        taskApprovals={taskApprovals}
        onTaskDecide={taskDecide}
        jevNotices={jevNotices}
        bot={bot}
        onBack={onBack}
        link={session.link}
        transcript={session.transcript}
        phase={session.phase}
        lastError={session.lastError}
        pending={session.pending}
        usage={session.usage}
        model={session.model}
        effort={session.effort}
        models={models}
        approvalMode={bot?.policies?.approvalMode ?? "manual"}
        queued={session.queued}
        onInput={session.input}
        onWithdraw={session.withdraw}
        onDecide={session.decide}
        onConfigure={session.configure}
        onApprovalMode={changeApprovalMode}
        onInterrupt={requestStop}
      />
      <StopDialog
        open={askStop}
        running={chatTasks.running.length}
        onOpenChange={setAskStop}
        onStop={async (tasks) => {
          await session.interrupt(tasks);
          if (tasks) await chatTasks.refresh();
        }}
      />
    </div>
  );
}
