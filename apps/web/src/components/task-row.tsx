/**
 * A background task as one recognizable row, the same wherever tasks are
 * listed (the chat header's task list, Now, a bot's Work tab): its status
 * mark, its title (opens its work in the work pane), the shared meta line
 * (status · time · what it is doing now) and, while it runs or waits, its
 * own Stop with a light inline confirm. `TaskLine` is the same row without
 * the title, for the chat, where the line above already names the task.
 */
import type { TaskInfo } from "@spriessen/contracts";
import { TaskStatusIcon } from "@/components/task-status-icon";
import { StopTask } from "@/components/task-sheet/stop-task";
import { RowButton } from "@/components/ui/row-button";
import { isLive, taskMeta, taskTitle } from "@/lib/task-text";
import { useOpenWork } from "@/lib/work-pane";
import { cn } from "@/lib/utils";

export function TaskRow({
  task,
  now,
  onChanged,
  botName,
}: {
  task: TaskInfo;
  now: number;
  onChanged: () => void;
  /** Named where tasks of several bots share a list (the Now page). */
  botName?: string | undefined;
}) {
  const openWork = useOpenWork();
  return (
    <li className="flex items-center gap-2.5 rounded-2xl px-2.5 py-1.5">
      <TaskStatusIcon status={task.status} />
      <RowButton
        onClick={() => openWork?.({ kind: "task", task })}
        className="flex min-h-11 min-w-0 flex-1 flex-col justify-center rounded-lg"
        title={task.prompt}
      >
        <span className="truncate text-sm font-medium">{taskTitle(task)}</span>
        <span className="text-muted-foreground truncate text-xs">
          {botName !== undefined && botName !== "" && `${botName} · `}
          {taskMeta(task, now)}
        </span>
      </RowButton>
      {isLive(task) && <StopTask id={task.id} onStopped={onChanged} />}
    </li>
  );
}

/** The task's live line under the chat's "Started a task" row: tap to open its work. */
export function TaskLine({
  task,
  now,
  onChanged,
  className,
}: {
  task: TaskInfo;
  now: number;
  onChanged: () => void;
  className?: string | undefined;
}) {
  const openWork = useOpenWork();
  return (
    <div className={cn("flex max-w-prose min-w-0 items-center gap-2", className)}>
      <RowButton
        onClick={() => openWork?.({ kind: "task", task })}
        className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-lg pl-1 pointer-coarse:min-h-11"
        aria-label={`Open the task's work: ${taskTitle(task)}`}
      >
        <TaskStatusIcon status={task.status} className="size-3.5" />
        <span className="text-muted-foreground truncate text-xs">{taskMeta(task, now)}</span>
      </RowButton>
      {isLive(task) && <StopTask id={task.id} onStopped={onChanged} />}
    </div>
  );
}
