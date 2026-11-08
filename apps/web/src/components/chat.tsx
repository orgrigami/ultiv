/**
 * The chat area of one session: live session wiring, the conversation's
 * background tasks (one list: the header chip, the live task lines in the
 * transcript, the Stop confirmation), and the full SessionView. Shared by the home screen (the
 * active bot's main chat) and the /sessions/$id page.
 */
import type { ChatBot } from "@/components/chat-header";
import { SessionView } from "@/components/session-view";
import { TasksChip } from "@/components/tasks-chip";
import { ChatTasksProvider } from "@/lib/chat-tasks";
import { StopDialog } from "@/components/stop-dialog";
import { api } from "@/lib/api";
import { useApp } from "@/lib/app-state";
import { useSession } from "@/lib/use-session";
import { useTasks } from "@/lib/use-tasks";
import { useJevNotices } from "@/lib/use-jev-notices";
import { useTaskApprovals } from "@/lib/use-task-approvals";
import { BranchProvider, useBranchActions } from "@/lib/branch";
import { useState } from "react";
import type { ModelInfo, ProfileApprovalMode, ProfileInfo } from "@spriessen/contracts";

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
  const branchActions = useBranchActions(sessionId);
  // Stop asks first only when this chat has background tasks running or queued.
  const requestStop = async (): Promise<void> => {
    if (chatTasks.live.length === 0) await session.interrupt();
    else setAskStop(true);
  };
  // The approval-mode switch PATCHes just the one policy key and refreshes
  // the app state, like every other profile mutation.
  const changeApprovalMode = async (mode: ProfileApprovalMode): Promise<void> => {
    if (bot?.id === undefined) return;
    await api.updateProfile(bot.id, { policies: { approvalMode: mode } });
    await refreshAll();
  };
  const { taskApprovals, taskDecide } = useTaskApprovals(chatTasks);
  return (
    <BranchProvider value={branchActions}>
      <ChatTasksProvider value={{ tasks: chatTasks.tasks, refresh: chatTasks.refresh }}>
        <div className="flex min-h-0 flex-1 flex-col">
          <SessionView
            sessionId={sessionId}
            tasks={<TasksChip chatTasks={chatTasks} />}
            taskInfo={chatTasks.tasks}
            taskApprovals={taskApprovals}
            onTaskDecide={taskDecide}
            jevNotices={jevNotices}
            bot={bot}
            onBack={onBack}
            link={session.link}
            loaded={session.loaded}
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
            onRetryQueued={session.retryQueued}
            onDecide={session.decide}
            onConfigure={session.configure}
            onApprovalMode={changeApprovalMode}
            onInterrupt={requestStop}
          />
          <StopDialog
            open={askStop}
            running={chatTasks.live.length}
            onOpenChange={setAskStop}
            onStop={async (tasks) => {
              await session.interrupt(tasks);
              if (tasks) await chatTasks.refresh();
            }}
          />
        </div>
      </ChatTasksProvider>
    </BranchProvider>
  );
}
