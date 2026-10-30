/**
 * The task sheet's header: the full title (two lines at most), a status pill,
 * the elapsed time, Stop (light inline confirm) and close.
 */
import type { TaskInfo } from "@ultiv/contracts";
import { XIcon } from "lucide-react";
import { TaskStatusIcon } from "@/components/task-status-icon";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogTitle } from "@/components/ui/dialog";
import { taskElapsed, taskStatusWord } from "@/lib/task-text";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { StopTask } from "./stop-task";

const PILL = {
  running: "bg-primary/10 text-primary",
  done: "bg-ok/10 text-ok",
  failed: "bg-destructive/10 text-destructive",
  cancelled: "bg-muted text-muted-foreground",
} as const;

/** The bot's own title, else the brief's first line — whole, the header wraps it. */
export function fullTitle(task: Pick<TaskInfo, "title" | "prompt">): string {
  const own = task.title?.trim() ?? "";
  if (own !== "") return own;
  return (task.prompt.split("\n")[0] ?? "").trim() || "Background task";
}

export function SheetHeader({ task, onChanged }: { task: TaskInfo; onChanged: () => void }) {
  const running = task.status === "running";
  const now = useNow(1_000, running);
  return (
    <div className="border-border/60 flex flex-col gap-2 border-b px-4 pb-3">
      <div className="flex items-start gap-2">
        <DialogTitle className="line-clamp-2 min-w-0 flex-1 pr-0 text-base leading-snug font-semibold break-words">
          {fullTitle(task)}
        </DialogTitle>
        <DialogClose
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="-mt-1 -mr-1 shrink-0"
              aria-label="Close"
            >
              <XIcon />
            </Button>
          }
        />
      </div>
      <div className="flex min-h-7 items-center gap-2 text-sm">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
            PILL[task.status],
          )}
        >
          <TaskStatusIcon status={task.status} className="size-3.5" />
          {taskStatusWord(task.status)}
        </span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {running ? "for " : "took "}
          {taskElapsed(task, now)}
        </span>
        <span className="flex-1" />
        {running && <StopTask id={task.id} onStopped={onChanged} />}
      </div>
    </div>
  );
}
