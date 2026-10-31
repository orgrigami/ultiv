/**
 * Needs you: the few things only the owner can settle, from data the app
 * already polls plus one read of tidy counts and escalations on each visit.
 * Every row opens the chat card or screen that settles it. Failed tasks and
 * routine escalations can be dismissed once seen; approvals and tidy
 * suggestions leave by being handled.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  BrainIcon,
  CalendarX2Icon,
  ChevronRightIcon,
  ShieldQuestionIcon,
  TriangleAlertIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useApp } from "@/lib/app-state";
import { formatWhen } from "@/lib/format";
import type { NeedsItem, NeedsKind } from "@/lib/needs-you";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/needs")({
  component: NeedsPage,
});

const KIND: Record<NeedsKind, { icon: LucideIcon; label: string; tone: string }> = {
  approval: { icon: ShieldQuestionIcon, label: "Approval", tone: "text-signal" },
  "failed-task": { icon: TriangleAlertIcon, label: "Task failed", tone: "text-warning" },
  escalation: { icon: CalendarX2Icon, label: "Routine", tone: "text-warning" },
  tidy: { icon: BrainIcon, label: "Memory", tone: "text-muted-foreground" },
};

function NeedsPage() {
  const { needs, reloadNeeds, dismissNeed, mainId } = useApp();
  const navigate = useNavigate();
  useEffect(() => void reloadNeeds(), [reloadNeeds]);

  const open = (item: NeedsItem): void => {
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

  return (
    <Page title="Needs you" lead="Approvals, failures and suggestions waiting on you.">
      {needs.length === 0 ? (
        <div className="bg-card flex flex-col items-center gap-1 rounded-xl border px-4 py-10 text-center">
          <p className="text-sm font-medium">Nothing needs you</p>
          <EmptyState>Approvals, failed tasks and memory suggestions show up here.</EmptyState>
        </div>
      ) : (
        <ul aria-label="Needs you" className="bg-card divide-border divide-y rounded-xl border">
          {needs.map((item) => {
            const kind = KIND[item.kind];
            const Icon = kind.icon;
            return (
              <li key={item.id} className="flex items-center gap-1 pr-1">
                <button
                  type="button"
                  onClick={() => open(item)}
                  className="hover:bg-muted/60 focus-visible:ring-ring/50 flex min-h-14 min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg py-2.5 pl-3 text-left outline-none focus-visible:ring-3"
                >
                  <span className="relative shrink-0">
                    <BotAvatar name={item.botName} />
                    <span className="bg-card absolute -right-1.5 -bottom-1 rounded-full p-0.5">
                      <Icon className={cn("size-3.5", kind.tone)} aria-hidden />
                    </span>
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-sm font-medium break-words">{item.title}</span>
                    {item.detail !== null && (
                      <span className="text-muted-foreground line-clamp-2 text-xs break-words">
                        {item.detail}
                      </span>
                    )}
                    <span className="text-muted-foreground text-xs">
                      {kind.label}
                      {item.at !== null ? ` · ${formatWhen(item.at)}` : ""}
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
              </li>
            );
          })}
        </ul>
      )}
    </Page>
  );
}
