/**
 * The chat's background tasks as one small translucent pill just above the
 * composer: "2 tasks running" plus what the newest one is doing. Tap to
 * expand into a row per task. Recently finished tasks linger briefly so a
 * finish is noticed; the pill lives in the measured footer, so the transcript
 * padding and "Jump to latest" already sit above it.
 */
import { useState } from "react";
import { ChevronUpIcon } from "lucide-react";
import { TaskRow } from "@/components/task-row";
import { TaskStatusIcon } from "@/components/task-status-icon";
import { pillLabel, pillTasks, taskLatest } from "@/lib/task-text";
import type { ChatTasks } from "@/lib/use-tasks";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

const glass = "chrome-float";

export function TasksPill({ chatTasks }: { chatTasks: ChatTasks }) {
  const [open, setOpen] = useState(false);
  const now = useNow(1_000, chatTasks.tasks.length > 0);
  const shown = pillTasks(chatTasks.tasks, now).toSorted((a, b) => b.createdAt - a.createdAt);
  if (shown.length === 0) return null;
  const running = shown.filter((task) => task.status === "running");
  const lead = running[0] ?? shown[0]!;
  const latest = running.length > 0 ? taskLatest(lead) : undefined;
  return (
    <div className="animate-in fade-in slide-in-from-bottom-1 flex w-full max-w-md flex-col items-center gap-1.5 self-center duration-200 motion-reduce:animate-none">
      {open && (
        <ul
          id="task-pill-list"
          aria-label="Background tasks"
          className={cn(
            glass,
            "animate-in fade-in slide-in-from-bottom-1 flex max-h-64 w-full flex-col overflow-y-auto rounded-3xl p-1 duration-150 motion-reduce:animate-none",
          )}
        >
          {shown.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              now={now}
              onChanged={() => void chatTasks.refresh()}
            />
          ))}
        </ul>
      )}
      <button
        type="button"
        aria-expanded={open}
        aria-controls="task-pill-list"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          glass,
          "focus-visible:ring-ring/50 flex min-h-11 max-w-full cursor-pointer items-center gap-2 rounded-full px-4 text-sm outline-none focus-visible:ring-3",
        )}
      >
        <TaskStatusIcon status={running.length > 0 ? "running" : lead.status} />
        <span className="shrink-0 font-medium">{pillLabel(shown)}</span>
        {!open && latest !== undefined && (
          <span className="text-muted-foreground min-w-0 truncate">· {latest}</span>
        )}
        <ChevronUpIcon
          aria-hidden
          className={cn(
            "text-muted-foreground size-4 shrink-0 transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>
    </div>
  );
}
