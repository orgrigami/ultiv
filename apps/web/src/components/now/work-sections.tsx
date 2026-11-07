/**
 * The Now page's work: background tasks running across every bot, and the
 * ones that finished cleanly in the last day (failures sit in Needs you).
 * Rows are the task pill's own rows, named by bot; a tap opens the task's
 * work. Data is the app's task list, refreshed by the `tasks` signal.
 */
import { TaskRow } from "@/components/task-row";
import { EmptyState } from "@/components/ui/empty-state";
import { ListCard } from "@/components/ui/list-card";
import { SectionHeader } from "@/components/ui/section-header";
import { useApp } from "@/lib/app-state";
import { botNameOf, finishedRecently, runningWork } from "@/lib/now";
import { useNow } from "@/lib/use-now";
import type { TaskInfo } from "@spriessen/contracts";

function TaskList({ tasks, now }: { tasks: readonly TaskInfo[]; now: number }) {
  const { sessions } = useApp();
  return (
    <ListCard as="ul" className="p-1">
      {tasks.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          now={now}
          botName={botNameOf(task, sessions.profiles)}
          onChanged={() => undefined}
        />
      ))}
    </ListCard>
  );
}

export function RunningSection() {
  const { tasks } = useApp();
  const running = runningWork(tasks);
  const now = useNow(1_000, running.length > 0);
  return (
    <section aria-label="Running" className="flex flex-col gap-2">
      <SectionHeader title={running.length > 0 ? `Running · ${running.length}` : "Running"} />
      {running.length === 0 ? (
        <EmptyState>No background work is running.</EmptyState>
      ) : (
        <TaskList tasks={running} now={now} />
      )}
    </section>
  );
}

export function FinishedSection() {
  const { tasks } = useApp();
  const now = useNow(60_000, true);
  const finished = finishedRecently(tasks, now);
  if (finished.length === 0) return null;
  return (
    <section aria-label="Finished today" className="flex flex-col gap-2">
      <SectionHeader title="Finished in the last day" />
      <TaskList tasks={finished} now={now} />
    </section>
  );
}
