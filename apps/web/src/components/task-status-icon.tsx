/** One mark per task status, shared by the task pill and the task cards. */
import type { TaskStatus } from "@ultiv/contracts";
import { Mark } from "@/components/state-mark";
import { cn } from "@/lib/utils";

export function TaskStatusIcon({ status, className }: { status: TaskStatus; className?: string }) {
  const base = cn("size-4 shrink-0", className);
  if (status === "running")
    return <Mark kind="working" tone="live" className={cn(base, "live-breathe")} />;
  if (status === "done") return <Mark kind="done" tone="ok" className={base} />;
  if (status === "failed") return <Mark kind="error" tone="signal" className={base} />;
  return <Mark kind="disabled" tone="muted" className={base} />;
}
