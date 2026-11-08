/**
 * The chat's background work as one small chip in the header, beside the
 * approval-mode chip: "2 running · 1 queued". It shows only while something
 * runs or waits, so it never covers the transcript; a tap lists the tasks
 * (anchored on sm+, a bottom sheet on phones), each opening its work.
 */
import { Popover } from "@base-ui/react/popover";
import type { TaskRow as TaskRowData } from "@spriessen/contracts";
import { TaskRow } from "@/components/task-row";
import { TaskStatusIcon } from "@/components/task-status-icon";
import {
  PopoverSheetBackdrop,
  SheetHeading,
  sheetPopup,
  sheetPositioner,
  usePhoneSheet,
} from "@/components/ui/menu-sheet";
import type { ChatTasks } from "@/lib/use-tasks";
import { chipAria, chipLabel, isLive } from "@/lib/task-text";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

/** Live work first: running, then queued, oldest first within each. */
const ordered = (tasks: readonly TaskRowData[]): TaskRowData[] =>
  tasks
    .filter(isLive)
    .toSorted(
      (a, b) =>
        Number(b.status === "running") - Number(a.status === "running") ||
        a.createdAt - b.createdAt,
    );

export function TasksChip({ chatTasks }: { chatTasks: ChatTasks }) {
  const phone = usePhoneSheet();
  const live = ordered(chatTasks.tasks);
  const now = useNow(1_000, live.length > 0);
  if (live.length === 0) return null;
  const running = live.some((task) => task.status === "running");
  return (
    <Popover.Root modal={phone}>
      <Popover.Trigger
        aria-label={chipAria(live)}
        className={cn(
          "chrome-float focus-visible:ring-ring/50 text-muted-foreground inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs font-medium outline-none focus-visible:ring-3 pointer-coarse:h-11",
        )}
      >
        <TaskStatusIcon status={running ? "running" : "queued"} className="size-3.5" />
        <span className="tnum max-sm:hidden">{chipLabel(live)}</span>
        <span className="tnum sm:hidden">{live.length}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <PopoverSheetBackdrop />
        <Popover.Positioner side="bottom" align="center" sideOffset={6} {...sheetPositioner}>
          <Popover.Popup className={cn(sheetPopup, "w-96 gap-1 p-2")}>
            <Popover.Title render={<SheetHeading always>Background work</SheetHeading>} />
            <ul aria-label="Background tasks" className="flex max-h-80 flex-col overflow-y-auto">
              {live.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  now={now}
                  onChanged={() => void chatTasks.refresh()}
                />
              ))}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
