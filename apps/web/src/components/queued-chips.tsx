/**
 * Messages the owner sent while the bot was busy, shown in the transcript in
 * the order they were sent: a softly greyed "pending" bubble that says when it
 * reaches the bot, with an × to take back just that one. Once the turn picks a
 * message up it leaves the queue and appears as a normal bubble.
 *
 * `stalled`: no turn is running (the last one failed or was cut off). Queued
 * messages are never sent by themselves then (D3); a Retry chip sends them.
 */
import type { QueuedInput } from "@spreissen/contracts";
import { RotateCcwIcon, XIcon } from "lucide-react";
import { Button } from "./ui/button.tsx";
import { displayText } from "../lib/attachments.ts";
import { queueLabel, type TurnActivity } from "../lib/queue-text.ts";

export function QueuedChips({
  queued,
  approvalPending,
  activity = "working",
  onWithdraw,
  stalled = false,
  onRetry,
}: {
  queued: readonly QueuedInput[];
  approvalPending: boolean;
  activity?: TurnActivity;
  onWithdraw: (id: string) => void;
  stalled?: boolean;
  onRetry?: () => void;
}) {
  if (queued.length === 0) return null;
  return (
    <>
      {queued.map((item) => (
        <li
          key={item.id}
          aria-label={`Pending message: ${displayText(item.text)}`}
          className="animate-in fade-in slide-in-from-bottom-1 flex max-w-[80%] min-w-0 flex-col items-end gap-0.5 self-end duration-200 motion-reduce:animate-none"
        >
          <span className="bg-muted/50 text-foreground/60 border-border flex max-w-full items-start gap-1 rounded-2xl border border-dashed py-1 pr-1 pl-4 leading-relaxed">
            <span className="min-w-0 py-1.5 break-words whitespace-pre-wrap">
              {displayText(item.text)}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 rounded-full pointer-coarse:size-11"
              aria-label={`Cancel queued message: ${displayText(item.text)}`}
              title="Cancel"
              onClick={() => onWithdraw(item.id)}
            >
              <XIcon />
            </Button>
          </span>
          <span className="text-muted-foreground px-1 text-xs">
            {queueLabel(item.mode, approvalPending, activity, stalled)}
          </span>
        </li>
      ))}
      {stalled && onRetry !== undefined && (
        <li className="flex self-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-full"
            aria-label={
              queued.length === 1
                ? "Retry: send the queued message"
                : `Retry: send the ${queued.length} queued messages`
            }
            onClick={onRetry}
          >
            <RotateCcwIcon />
            Retry
          </Button>
        </li>
      )}
    </>
  );
}
