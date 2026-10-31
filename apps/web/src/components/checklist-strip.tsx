/**
 * The plan, always in reach: a slim strip above the composer reading
 * "Tasks 2/4 · <the step in progress>". Tap to open the full list in place
 * (it pushes the transcript up instead of covering it, since the footer's
 * height is what the transcript reserves). It shows only while a plan is
 * open: a plan that finishes here reads "All done" for a moment and folds
 * away; one already finished when the chat opens is not shown.
 */
import { ChevronUpIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import type { ChecklistDetails } from "@spriessen/contracts";
import { ChecklistBox } from "./checklist-card.tsx";
import { DONE_LINGER_MS, planKey, stripLine } from "../lib/checklist-strip.ts";
import { cn } from "../lib/utils.ts";

/** Whether a finished plan should still show: only right after it finished here. */
function useLinger(listId: string | null, finished: boolean): boolean {
  // Plans already finished when first seen are hidden at once.
  const seenOpen = useRef(new Set<string>());
  const [gone, setGone] = useState<string | null>(null);
  if (listId !== null && !finished) seenOpen.current.add(listId);
  useEffect(() => {
    if (listId === null || !finished || !seenOpen.current.has(listId)) return;
    const timer = setTimeout(() => setGone(listId), DONE_LINGER_MS);
    return () => clearTimeout(timer);
  }, [listId, finished]);
  if (listId === null) return false;
  if (!finished) return true;
  return seenOpen.current.has(listId) && gone !== listId;
}

function StripBody({ list }: { list: ChecklistDetails | null }) {
  const line = list === null ? null : stripLine(list);
  const visible = useLinger(list?.listId ?? null, line?.finished ?? false);
  const [open, setOpen] = useState(false);
  if (list === null || line === null || !visible) return null;
  const label = `Tasks, ${line.done} of ${line.total} done`;
  return (
    <div className="animate-in fade-in slide-in-from-bottom-1 chrome-float flex w-full max-w-md flex-col self-center overflow-hidden rounded-2xl duration-200 motion-reduce:animate-none">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? `${label}. Hide the steps` : `${label}. Show the steps`}
        onClick={() => setOpen((now) => !now)}
        className="focus-visible:ring-ring/50 press flex min-h-11 w-full cursor-pointer items-center gap-2 px-3.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset"
      >
        <ChecklistBox status={line.finished ? "done" : "in_progress"} />
        <span className="shrink-0 font-medium">Tasks</span>
        <span
          className={cn(
            "readout shrink-0 text-xs",
            line.finished ? "text-ok" : "text-muted-foreground",
          )}
        >
          {line.done}/{line.total}
        </span>
        <span className="text-muted-foreground min-w-0 flex-1 truncate">
          · {line.current ?? "All done"}
        </span>
        <ChevronUpIcon
          aria-hidden
          className={cn(
            "text-muted-foreground size-4 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <ol className="border-border/60 flex max-h-[min(30dvh,16rem)] flex-col gap-2 overflow-y-auto border-t px-3.5 py-3">
          {list.items.map((item, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the plan's steps are positional
            <li key={index} className="flex items-start gap-2.5 text-sm leading-snug">
              <ChecklistBox status={item.status} />
              <span
                className={cn(
                  "min-w-0 break-words",
                  item.status === "done" && "text-muted-foreground line-through decoration-1",
                  item.status === "in_progress" && "font-medium",
                )}
              >
                {item.text}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Re-renders only when the plan itself changes, not on every streamed token. */
export const ChecklistStrip = memo(
  StripBody,
  (before, after) => planKey(before.list) === planKey(after.list),
);
