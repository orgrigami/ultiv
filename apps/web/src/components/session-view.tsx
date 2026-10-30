import { useRef, useState } from "react";
import type {
  ModelInfo,
  PendingApproval,
  Phase,
  ProfileApprovalMode,
  QueuedInput,
  TaskInfo,
  TaskRow,
  ThinkingLevel,
  TranscriptEntry,
  UsageSummary,
  SendMode,
} from "@ultiv/contracts";
import { ArrowDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ApprovalCard, type Decide, type DecideOutcome } from "@/components/approval-card";
import { ChatSkeleton, EmptyChat, StatusRow } from "@/components/chat-states";
import { Composer } from "@/components/composer";
import { MemoryPanel } from "@/components/memory/memory-panel";
import { QueuedChips } from "@/components/queued-chips";
import { ChatHeader, type ChatBot, type LinkState } from "@/components/chat-header";
import { TranscriptItems } from "@/components/transcript-items";
import { describeTool } from "@/lib/approval-text";
import type { JevNotice } from "@/lib/jev-text";
import { turnActivity } from "@/lib/queue-text";
import { aboveComposer, useChatScroll } from "@/lib/use-chat-scroll";

/**
 * The polite live-region text: a finished reply or a gate waiting on the
 * owner. Whatever was already on screen at mount is not re-announced.
 */
function useAnnouncement(
  botName: string | undefined,
  transcript: TranscriptEntry[],
  pending: PendingApproval,
): string {
  const who = botName !== undefined && botName !== "" ? botName : "The bot";
  const lastReply = transcript.findLast((entry) => entry.kind === "output" && !entry.streaming);
  const seen = useRef<number | null | undefined>(undefined);
  if (seen.current === undefined && transcript.length > 0) seen.current = lastReply?.id ?? null;
  if (pending !== null)
    return `${who} needs your approval to ${describeTool(pending.name).action}.`;
  if (lastReply === undefined || lastReply.kind !== "output" || lastReply.id === seen.current) {
    return "";
  }
  return `${who}: ${lastReply.text.slice(0, 280)}`;
}

/** The draft and sending it. A failed send keeps the draft and offers a retry. */
function useSend(onInput: (text: string, whenBusy?: SendMode) => Promise<void>) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  // While the bot works a send joins its turn (or waits for it): busy does not block.
  const run = async (whenBusy?: SendMode): Promise<void> => {
    const text = draft.trim();
    if (text === "" || sending) return;
    setSending(true);
    setSendFailed(false);
    try {
      await onInput(text, whenBusy);
      // Clear only what was sent — anything typed meanwhile stays.
      setDraft((current) => (current.trim() === text ? "" : current));
    } catch {
      setSendFailed(true);
    } finally {
      setSending(false);
    }
  };

  return { draft, setDraft, sending, sendFailed, run };
}

/** Floats just above the composer while the owner is scrolled up. */
function JumpToLatest({ bottom, onJump }: { bottom: string; onJump: () => void }) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onJump}
      className="bg-background/70 absolute left-1/2 z-10 -translate-x-1/2 rounded-full shadow-sm backdrop-blur-md"
      style={{ bottom }}
    >
      <ArrowDownIcon /> Jump to latest
    </Button>
  );
}

/** A task's waiting gate, popped into the thread that spawned the task. */
export interface TaskApproval {
  task: TaskRow;
  callId: string;
  name: string;
  input: unknown;
  reason: string | null;
}

/** The card's who-line: the task is asking, not the bot itself. */
const taskWho = (botName: string | undefined, task: TaskRow): string => {
  const who = botName !== undefined && botName !== "" ? botName : "Your bot";
  const label = (task.title ?? task.prompt).slice(0, 40);
  return `${who} · task "${label}"`;
};

const floatingError =
  "bg-background/70 text-destructive w-fit rounded-lg px-3 py-1.5 text-sm backdrop-blur-md";

export function SessionView({
  bot,
  onBack,
  link,
  transcript,
  phase,
  lastError,
  pending,
  usage,
  model,
  effort,
  models,
  approvalMode,
  queued = [],
  onInput,
  onWithdraw,
  onDecide,
  onConfigure,
  onApprovalMode,
  onInterrupt,
  tasks,
  taskInfo = [],
  taskApprovals = [],
  onTaskDecide,
  jevNotices,
}: {
  bot?: ChatBot | undefined;
  /** Shown as the header's round back button when set. */
  onBack?: (() => void) | undefined;
  link: LinkState;
  transcript: TranscriptEntry[];
  phase: Phase;
  lastError: string | null;
  pending: PendingApproval;
  usage: UsageSummary | null;
  model: string | null;
  effort: ThinkingLevel | null;
  models: ModelInfo[];
  /** This bot's approval mode; the header popover switches it. */
  approvalMode: ProfileApprovalMode;
  /** Messages waiting for the running turn, shown as pending bubbles at the end of the transcript. */
  queued?: readonly QueuedInput[];
  onInput: (text: string, whenBusy?: SendMode) => Promise<void>;
  onWithdraw?: (id: string) => Promise<void>;
  onDecide: Decide;
  onConfigure: (model: string | null, effort: ThinkingLevel | null) => Promise<void>;
  onApprovalMode: (mode: ProfileApprovalMode) => Promise<void>;
  onInterrupt: () => Promise<void>;
  /** Background tasks, floated above the composer. */
  tasks?: React.ReactNode;
  /** This chat's task rows, for the task cards in the transcript. */
  taskInfo?: readonly TaskInfo[];
  /** Gates waiting on this chat's tasks, shown as cards in the thread. */
  taskApprovals?: readonly TaskApproval[];
  /** Decides a task's waiting gate (routes REST to the task's own conversation). */
  onTaskDecide: (
    task: TaskRow,
    approved: boolean,
    always?: boolean,
    takeover?: boolean,
    input?: unknown,
  ) => Promise<DecideOutcome | void>;
  /** Jev's gate decisions by tool call id, shown under the calls. */
  jevNotices?: ReadonlyMap<string, JevNotice> | undefined;
}) {
  const busy = phase === "working";
  const { draft, setDraft, sending, sendFailed, run } = useSend(onInput);
  // The bot's Memory panel, opened from the switcher or a memory chip.
  const [memory, setMemory] = useState<{ open: boolean; query: string }>({
    open: false,
    query: "",
  });
  const openMemory = (query: string): void => setMemory({ open: true, query });
  const hasBot = bot?.id !== undefined;
  // Control failures (model/effort/stop) are reported above the composer.
  const [controlError, setControlError] = useState<string | null>(null);
  const { transcriptRef, footerRef, footerHeight, atBottom, jumpToLatest } = useChatScroll([
    transcript,
    busy,
    pending,
    queued,
    // A task card popping into the thread re-pins the transcript too.
    taskApprovals.length,
  ]);

  const control = (action: () => Promise<void>): void => {
    setControlError(null);
    action().catch((cause: unknown) => {
      setControlError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  const announcement = useAnnouncement(bot?.name, transcript, pending);

  // Frameless: the chat is the page. The transcript fills it and scrolls
  // UNDER the translucent header and composer, which float on top.
  // --chat-bottom is how much the page reserves below (the phone tab bar).
  return (
    <>
      <section aria-label="Chat" className="relative min-h-0 flex-1">
        <div ref={transcriptRef} className="absolute inset-0">
          <ScrollArea className="h-full">
            <ul
              className="flex flex-col gap-3 pt-[calc(3.75rem+env(safe-area-inset-top))]"
              style={{
                paddingBottom: aboveComposer(footerHeight, 12),
              }}
            >
              {transcript.length === 0 && link === "connecting" && <ChatSkeleton />}
              {transcript.length === 0 && link === "live" && !busy && (
                <EmptyChat bot={bot} onPick={setDraft} />
              )}
              <TranscriptItems
                transcript={transcript}
                busy={busy}
                tasks={taskInfo}
                jevNotices={jevNotices}
                onOpenMemory={hasBot ? openMemory : undefined}
              />
              {pending !== null ? (
                <li>
                  <ApprovalCard
                    name={pending.name}
                    input={pending.input}
                    reason={pending.reason}
                    who={bot?.name}
                    callId={pending.callId}
                    models={models}
                    onDecide={(approved, always, takeover, input) =>
                      onDecide(pending.callId, approved, always, takeover, input)
                    }
                  />
                </li>
              ) : (
                busy && <StatusRow bot={bot} transcript={transcript} pending={pending} />
              )}
              {/* A task's gate pops into the thread that spawned it, labelled as the task. */}
              {taskApprovals.map(({ task, callId, name, input, reason }) => (
                <li key={`${task.id}:${callId}`}>
                  <ApprovalCard
                    name={name}
                    input={input}
                    reason={reason}
                    who={taskWho(bot?.name, task)}
                    callId={callId}
                    models={models}
                    onDecide={(approved, always, takeover, input) =>
                      onTaskDecide(task, approved, always, takeover, input)
                    }
                  />
                </li>
              ))}
              {/* Sent while busy: pending bubbles, in order, until the turn picks them up. */}
              {onWithdraw !== undefined && (
                <QueuedChips
                  queued={queued}
                  approvalPending={pending !== null}
                  activity={turnActivity(transcript)}
                  onWithdraw={(id) => control(() => onWithdraw(id))}
                />
              )}
            </ul>
          </ScrollArea>
        </div>
        <div className="from-background via-background/70 pointer-events-none absolute inset-x-0 top-0 z-10 h-[calc(max(0.5rem,env(safe-area-inset-top))+4rem)] bg-linear-to-b to-transparent" />
        <div className="absolute inset-x-0 top-0 z-10 pt-[max(0.5rem,env(safe-area-inset-top))]">
          <ChatHeader
            bot={bot}
            link={link}
            onBack={onBack}
            usage={usage}
            model={model}
            effort={effort}
            models={models}
            approvalMode={approvalMode}
            onConfigure={(nextModel, nextEffort) =>
              control(() => onConfigure(nextModel, nextEffort))
            }
            onApprovalMode={(mode) => control(() => onApprovalMode(mode))}
            onMemory={hasBot ? () => openMemory("") : undefined}
          />
        </div>
        {/* Screen readers hear new replies and approval requests. */}
        <p aria-live="polite" className="sr-only">
          {announcement}
        </p>
        {!atBottom && (
          <JumpToLatest bottom={aboveComposer(footerHeight, 8)} onJump={jumpToLatest} />
        )}
        <footer
          ref={footerRef}
          className="pointer-events-none absolute inset-x-0 z-10 flex flex-col gap-2 pb-3 *:pointer-events-auto"
          style={{ bottom: "var(--chat-bottom, env(safe-area-inset-bottom))" }}
        >
          {tasks}
          {lastError !== null && <p className={floatingError}>{lastError}</p>}
          {controlError !== null && (
            <p className={floatingError}>Couldn't apply that: {controlError}</p>
          )}
          <Composer
            botName={bot?.name}
            live={link === "live"}
            busy={busy}
            sending={sending}
            sendFailed={sendFailed}
            draft={draft}
            onDraft={setDraft}
            onSend={(whenBusy) => void run(whenBusy)}
            onStop={() => control(onInterrupt)}
          />
        </footer>
      </section>
      {bot?.id !== undefined && (
        <MemoryPanel
          profileId={bot.id}
          name={bot.name}
          open={memory.open}
          onOpenChange={(open) => setMemory((current) => ({ ...current, open }))}
          initialQuery={memory.query}
        />
      )}
    </>
  );
}
