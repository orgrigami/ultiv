/**
 * The work linked to one project (GET /api/projects `work`): the tasks the
 * bot spawned for it and the routines it set for it. A task opens its work
 * in the pane when the app still holds it; a routine links to the bot's
 * Routines tab, where the owner edits or pauses it.
 */
import { Link } from "@tanstack/react-router";
import { CalendarClockIcon } from "lucide-react";
import type { ProjectWork } from "@spriessen/contracts";
import { TaskStatusIcon } from "@/components/task-status-icon";
import { RowButton } from "@/components/ui/row-button";
import { useApp } from "@/lib/app-state";
import { cronToText } from "@/lib/cron-text";
import { formatWhen } from "@/lib/format";
import { useOpenWork } from "@/lib/work-pane";

type Status = "running" | "done" | "failed" | "cancelled";

const asStatus = (status: string): Status =>
  status === "running" || status === "failed" || status === "cancelled" ? status : "done";

/** "Every Monday at 9:00", "Once, 3 Nov 14:00", or the raw cron when unreadable. */
export const routineWhen = (job: ProjectWork["routines"][number]): string =>
  job.once !== null ? `Once, ${formatWhen(job.once)}` : (cronToText(job.schedule) ?? job.schedule);

export function ProjectWorkList({ work, botId }: { work: ProjectWork; botId: string }) {
  const { tasks } = useApp();
  const openWork = useOpenWork();
  if (work.tasks.length === 0 && work.routines.length === 0) return null;
  return (
    <ul aria-label="Linked work" className="flex flex-col gap-0.5 border-t pt-2 text-sm">
      {work.tasks.map((row) => {
        const task = tasks.find((candidate) => candidate.id === row.id);
        return (
          <li key={row.id}>
            <RowButton
              disabled={task === undefined || openWork === null}
              onClick={() => task !== undefined && openWork?.({ kind: "task", task })}
              className="hover:bg-muted/60 flex min-h-9 w-full items-center gap-2 rounded-lg px-1.5 text-left disabled:cursor-default disabled:hover:bg-transparent"
            >
              <TaskStatusIcon status={asStatus(row.status)} />
              <span className="min-w-0 flex-1 truncate">{row.title}</span>
              <span className="text-muted-foreground shrink-0 text-xs">
                {formatWhen(row.finishedAt ?? row.createdAt)}
              </span>
            </RowButton>
          </li>
        );
      })}
      {work.routines.map((job) => (
        <li key={job.id}>
          <Link
            to="/crew/$botId"
            params={{ botId }}
            search={{ tab: "routines" }}
            className="hover:bg-muted/60 flex min-h-9 items-center gap-2 rounded-lg px-1.5"
          >
            <CalendarClockIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate" title={job.prompt}>
              {job.prompt}
            </span>
            <span className="text-muted-foreground shrink-0 text-xs">
              {!job.enabled ? "Paused" : job.trial ? "Trial" : routineWhen(job)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
