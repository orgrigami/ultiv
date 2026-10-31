/**
 * The Needs you list, shared by the Needs you screen and the work pane.
 * Approvals carry their card inline, so Approve or Deny is one tap from the
 * list (no detour through the chat); a settled one says so for a moment.
 * Failed tasks open their work; the rest open the chat or screen that settles
 * them. Failed tasks and routine escalations can be dismissed once seen.
 */
import { CharacterEmpty } from "@/components/character-empty";
import { useNavigate } from "@tanstack/react-router";
import {
  BrainIcon,
  CalendarX2Icon,
  CheckIcon,
  ChevronRightIcon,
  ShieldQuestionIcon,
  TriangleAlertIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApprovalCard } from "@/components/approval-card";
import { BotAvatar } from "@/components/bot-avatar";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useApp } from "@/lib/app-state";
import { formatWhen } from "@/lib/format";
import type { NeedsItem, NeedsKind } from "@/lib/needs-you";
import { cn } from "@/lib/utils";
import { useOpenWork } from "@/lib/work-pane";

const KIND: Record<NeedsKind, { icon: LucideIcon; label: string; tone: string }> = {
  approval: { icon: ShieldQuestionIcon, label: "Approval", tone: "text-signal" },
  "failed-task": { icon: TriangleAlertIcon, label: "Task failed", tone: "text-warning" },
  escalation: { icon: CalendarX2Icon, label: "Routine", tone: "text-warning" },
  tidy: { icon: BrainIcon, label: "Memory", tone: "text-muted-foreground" },
};

/** How long "Approved" / "Denied" stays before the row leaves. */
const SETTLED_MS = 1_800;

interface Settled {
  readonly id: string;
  readonly approved: boolean;
  readonly title: string;
}

function useOpenTarget(): (item: NeedsItem) => void {
  const { mainId, tasks } = useApp();
  const navigate = useNavigate();
  const openWork = useOpenWork();
  return (item) => {
    const task =
      item.kind === "failed-task" ? tasks.find((row) => `task:${row.id}` === item.id) : undefined;
    if (task !== undefined && openWork !== null) return openWork({ kind: "task", task });
    const target = item.target;
    if (target.kind === "session")
      void navigate({ to: "/c/$sessionId", params: { sessionId: target.sessionId } });
    else if (target.kind === "bot-chat")
      void navigate({ to: "/", search: target.botId === mainId ? {} : { bot: target.botId } });
    else
      void navigate({
        to: "/crew/$botId",
        params: { botId: target.botId },
        search: { tab: target.tab },
      });
  };
}

export function NeedsList({ className }: { className?: string }) {
  const { needs, dismissNeed, reloadApprovals, sessions } = useApp();
  const open = useOpenTarget();
  const [settled, setSettled] = useState<readonly Settled[]>([]);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((id) => window.clearTimeout(id)), []);

  const settle = (item: NeedsItem, approved: boolean): void => {
    setSettled((current) => [...current, { id: item.id, approved, title: item.title }]);
    timers.current.push(
      window.setTimeout(
        () => setSettled((current) => current.filter((row) => row.id !== item.id)),
        SETTLED_MS,
      ),
    );
  };

  const settledIds = new Set(settled.map((row) => row.id));
  const rows = needs.filter((item) => !settledIds.has(item.id));

  if (rows.length === 0 && settled.length === 0)
    return (
      <CharacterEmpty title="All clear" className={cn("py-10", className)}>
        Approvals, failed tasks and memory suggestions show up here.
      </CharacterEmpty>
    );

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {settled.map((row) => (
        <p
          key={row.id}
          role="status"
          className={cn(
            "settle-in flex min-h-12 items-center gap-2.5 rounded-2xl border px-3 text-sm font-medium",
            row.approved ? "border-ok/30 bg-ok/10 text-ok" : "bg-muted text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "settle-mark flex size-6 shrink-0 items-center justify-center rounded-full",
              row.approved ? "bg-ok text-background" : "bg-muted-foreground/20",
            )}
          >
            {row.approved ? <CheckIcon className="size-4" /> : <XIcon className="size-4" />}
          </span>
          <span className="min-w-0 truncate">
            {row.approved ? "Approved" : "Denied"} · {row.title}
          </span>
        </p>
      ))}
      {rows.length > 0 && (
        <ul aria-label="Needs you" className="bg-card divide-border divide-y rounded-3xl border">
          {rows.map((item) => {
            const kind = KIND[item.kind];
            const Icon = kind.icon;
            const approval = item.approval;
            return (
              <li key={item.id} className="flex flex-col">
                <div className="flex items-center gap-1 pr-1">
                  <button
                    type="button"
                    onClick={() => open(item)}
                    className="hover:bg-muted/60 focus-visible:ring-ring/50 press flex min-h-14 min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-2xl py-2.5 pl-3 text-left outline-none focus-visible:ring-3"
                  >
                    <span className="relative shrink-0">
                      <BotAvatar id={item.botId} name={item.botName} />
                      <span className="bg-card absolute -right-1.5 -bottom-1 rounded-full p-0.5">
                        <Icon className={cn("size-3.5", kind.tone)} aria-hidden />
                      </span>
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-sm font-medium break-words">{item.title}</span>
                      {item.detail !== null && approval === undefined && (
                        <span className="text-muted-foreground line-clamp-2 text-xs break-words">
                          {item.detail}
                        </span>
                      )}
                      <span className="text-muted-foreground text-xs">
                        {kind.label}
                        {item.at !== null ? ` · ${formatWhen(item.at)}` : ""}
                        {approval !== undefined ? " · open the chat" : ""}
                      </span>
                    </span>
                    <ChevronRightIcon className="text-muted-foreground size-4 shrink-0" />
                  </button>
                  {item.dismissable && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Dismiss: ${item.title}`}
                      onClick={() => dismissNeed(item.id)}
                    >
                      <XIcon />
                    </Button>
                  )}
                </div>
                {approval !== undefined && (
                  <div className="px-3 pb-3">
                    <ApprovalCard
                      name={approval.name}
                      input={approval.input}
                      reason={approval.reason}
                      who={item.botName}
                      callId={approval.callId}
                      models={sessions.models}
                      onDecide={async (approved, always, takeover, input) => {
                        // A failure throws into the card, which keeps it for a retry.
                        const result = await api.approvalDecide(
                          approval.conversationId,
                          approval.callId,
                          approved,
                          always,
                          takeover,
                          input,
                        );
                        settle(item, approved);
                        void reloadApprovals();
                        return { stored: result.stored };
                      }}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
