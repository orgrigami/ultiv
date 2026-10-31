/**
 * A small pill above the composer when something needs the owner outside
 * this chat (another bot's approval, a failed task). Tap: the Needs you list
 * opens in the work pane, where approvals settle inline.
 */
import { ChevronRightIcon, ShieldQuestionIcon } from "lucide-react";
import { useApp } from "@/lib/app-state";
import { needsElsewhere, needsPillLabel } from "@/lib/needs-you";
import { useOpenWork } from "@/lib/work-pane";

export function NeedsPill({
  sessionId,
  botId,
}: {
  sessionId?: string | undefined;
  botId?: string | undefined;
}) {
  const { needs } = useApp();
  const openWork = useOpenWork();
  const items = needsElsewhere(needs, { sessionId, botId });
  if (items.length === 0 || openWork === null) return null;
  return (
    <button
      type="button"
      onClick={() => openWork({ kind: "needs" })}
      className="chrome-float focus-visible:ring-ring/50 press animate-in fade-in slide-in-from-bottom-1 flex min-h-11 max-w-[min(28rem,100%)] cursor-pointer items-center gap-2 self-center rounded-full px-4 text-sm outline-none duration-200 focus-visible:ring-3 motion-reduce:animate-none"
    >
      <ShieldQuestionIcon aria-hidden className="text-signal size-4 shrink-0" />
      <span className="min-w-0 truncate font-medium">{needsPillLabel(items)}</span>
      <ChevronRightIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
    </button>
  );
}
