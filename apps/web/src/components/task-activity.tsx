/**
 * A background task's sheet: header (title, status, elapsed, Stop, close),
 * the brief folded to two lines, the steps as a friendly timeline that
 * follows the newest step, any approval waiting on it, the result card and
 * the files it made. Full height on phones so nothing floats over it.
 */
import { useMemo, useState } from "react";
import type { TaskInfo } from "@ultiv/contracts";
import { ArrowDownIcon } from "lucide-react";
import { FileCard } from "@/components/file-card";
import { ApprovalCard } from "@/components/approval-card";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { BriefRow } from "@/components/task-sheet/brief-row";
import { ResultCard } from "@/components/task-sheet/result-card";
import { SheetHeader } from "@/components/task-sheet/sheet-header";
import { Timeline } from "@/components/task-sheet/timeline";
import { useFollow } from "@/components/task-sheet/use-follow";
import { useTaskActivity } from "@/components/task-sheet/use-task-activity";
import type { ArtifactRow } from "@/lib/api";
import { formatWhen } from "@/lib/format";
import { timelineOf } from "@/lib/task-steps";

const SHEET =
  "flex flex-col overflow-hidden p-0 pt-4 sm:p-0 sm:pt-4 h-[calc(100dvh-max(0.75rem,env(safe-area-inset-top)))] max-h-none sm:h-[85dvh]";

function Files({ files }: { files: readonly ArtifactRow[] }) {
  if (files.length === 0) return null;
  return (
    <section aria-label="Files from this task" className="flex flex-col gap-1.5">
      <h3 className="text-muted-foreground text-xs font-medium">Files</h3>
      {files.map((file) => (
        <FileCard key={file.id} file={file} />
      ))}
    </section>
  );
}

function SheetBody({ task, open }: { task: TaskInfo; open: boolean }) {
  const { activity, files, error, load, decide } = useTaskActivity(task, open);
  const running = task.status === "running";
  const items = useMemo(
    () =>
      timelineOf(activity?.steps ?? [], task.prompt, task.status === "done" ? task.result : null),
    [activity, task.prompt, task.status, task.result],
  );
  const lastKey = `${items.length}:${items.at(-1)?.key ?? ""}:${task.status}:${activity?.waiting?.callId ?? ""}`;
  const follow = useFollow(lastKey);
  return (
    <>
      <SheetHeader task={task} onChanged={() => void load()} />
      <div
        ref={follow.ref}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-4 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))]"
      >
        <BriefRow brief={task.prompt} />
        {error !== null && (
          <p role="alert" className="text-destructive text-sm">
            Couldn't load the latest steps. Retrying…
          </p>
        )}
        {activity === null && error === null ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : (
          <Timeline items={items} running={running} />
        )}
        {activity?.waiting !== null && activity?.waiting !== undefined && (
          <ApprovalCard
            name={activity.waiting.name}
            input={activity.waiting.input}
            reason={activity.waiting.reason}
            who="This task"
            callId={activity.waiting.callId}
            onDecide={decide}
          />
        )}
        <ResultCard task={task} />
        <Files files={files} />
        <p className="text-muted-foreground text-center text-xs">
          Started {formatWhen(task.createdAt)}
          {task.finishedAt !== null && ` · finished ${formatWhen(task.finishedAt)}`}
        </p>
      </div>
      {!follow.atBottom && (
        <button
          type="button"
          onClick={follow.jump}
          className="bg-background/80 border-border/70 focus-visible:ring-ring/50 animate-in fade-in absolute bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 flex min-h-11 -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full border px-4 text-sm font-medium shadow-md outline-none backdrop-blur-xl focus-visible:ring-3 motion-reduce:animate-none"
        >
          <ArrowDownIcon aria-hidden className="size-4" />
          Jump to latest
        </button>
      )}
    </>
  );
}

export function TaskActivityDialog({
  task,
  children,
}: {
  task: TaskInfo;
  children: React.ReactElement;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={children} />
      <DialogContent showCloseButton={false} className={SHEET}>
        <SheetBody task={task} open={open} />
      </DialogContent>
    </Dialog>
  );
}
