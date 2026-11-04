/**
 * The bot's plan for multi-step work: "Tasks 2/4", a thin progress bar, and
 * one row per step. Done steps are ticked and struck through, the one in
 * progress carries the live amber mark, the rest wait as empty boxes. The
 * transcript shows one card per plan, at its latest update.
 */
import { CheckIcon } from "lucide-react";
import type { ChecklistDetails, ChecklistItem } from "@spriessen/contracts";
import { cn } from "../lib/utils.ts";
import { Tile } from "./ui/tile.tsx";

const SPOKEN: Record<ChecklistItem["status"], string> = {
  done: "done",
  in_progress: "in progress",
  pending: "to do",
};

export function ChecklistBox({ status }: { status: ChecklistItem["status"] }) {
  if (status === "done") {
    return (
      <span className="bg-ok text-background mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[5px]">
        <CheckIcon className="size-3" strokeWidth={3} aria-hidden />
      </span>
    );
  }
  if (status === "in_progress") {
    return (
      <span className="border-live mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[5px] border">
        {/* ai-design-check-ignore-next-line pulse-for-live-only -- the step the bot is working on right now: live state, motion-safe only */}
        <span className="bg-live size-2 rounded-[3px] motion-safe:animate-pulse" />
      </span>
    );
  }
  return (
    <span className="border-muted-foreground/45 mt-0.5 size-4 shrink-0 rounded-[5px] border" />
  );
}

export function ChecklistCard({
  list,
  className,
}: {
  list: ChecklistDetails;
  className?: string | undefined;
}) {
  const done = list.items.filter((item) => item.status === "done").length;
  const total = list.items.length;
  const settled = done === total;
  return (
    <Tile
      radius="2xl"
      render={<section aria-label={`Tasks, ${done} of ${total} done`} />}
      className={cn("min-w-0 max-w-prose px-3.5 pt-3 pb-3.5", className)}
    >
      <header className="flex items-baseline gap-2">
        <span className="text-sm font-medium">Tasks</span>
        <span className={cn("readout text-xs", settled ? "text-ok" : "text-muted-foreground")}>
          {done}/{total}
        </span>
        {list.title !== null && (
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-right text-xs">
            {list.title}
          </span>
        )}
      </header>
      <div className="bg-muted mt-2 h-1 overflow-hidden rounded-full" aria-hidden>
        <div
          className="bg-ok h-full rounded-full transition-[width] duration-200 motion-reduce:transition-none"
          style={{ width: `${(done / total) * 100}%` }}
        />
      </div>
      <ol className="mt-3 flex flex-col gap-2">
        {list.items.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the plan's steps are positional
          <li key={index} className="flex items-start gap-2.5 text-sm leading-snug">
            <ChecklistBox status={item.status} />
            <span
              className={cn(
                "min-w-0 break-words",
                item.status === "done" && "text-muted-foreground line-through decoration-1",
                item.status === "in_progress" && "text-foreground font-medium",
                item.status === "pending" && "text-foreground/85",
              )}
            >
              {item.text}
              <span className="sr-only"> ({SPOKEN[item.status]})</span>
            </span>
          </li>
        ))}
      </ol>
    </Tile>
  );
}
