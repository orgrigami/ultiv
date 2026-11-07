/**
 * The Work tab's bookends: the bot's running background tasks (the app's
 * task list, filtered to the bot) and its routines in one line each, with
 * the Routines tab one tap away for editing.
 */
import { Link } from "@tanstack/react-router";
import type { ProfileInfo } from "@spriessen/contracts";
import { TaskRow } from "@/components/task-row";
import { EmptyState } from "@/components/ui/empty-state";
import { ListCard } from "@/components/ui/list-card";
import { SectionHeader } from "@/components/ui/section-header";
import { api } from "@/lib/api";
import { useApp } from "@/lib/app-state";
import { cronToText } from "@/lib/cron-text";
import { formatWhen } from "@/lib/format";
import { runningWork } from "@/lib/now";
import { useLiveLoad } from "@/lib/use-live-load";
import { useNow } from "@/lib/use-now";

export function BotRunningWork({ bot }: { bot: ProfileInfo }) {
  const { tasks } = useApp();
  const running = runningWork(tasks.filter((task) => task.bot?.profileId === bot.id));
  const now = useNow(1_000, running.length > 0);
  return (
    <section aria-label="Running now" className="flex flex-col gap-2">
      <SectionHeader title="Running now" />
      {running.length === 0 ? (
        <EmptyState>{bot.name} has no background work running.</EmptyState>
      ) : (
        <ListCard as="ul" className="p-1">
          {running.map((task) => (
            <TaskRow key={task.id} task={task} now={now} onChanged={() => undefined} />
          ))}
        </ListCard>
      )}
    </section>
  );
}

export function BotRoutinesSummary({ bot }: { bot: ProfileInfo }) {
  const jobs = useLiveLoad(
    "work-routines",
    () => api.cron(),
    ["routines"],
    "Routines may be out of date",
  );
  const mine = (jobs.value ?? []).filter((job) => job.profile === bot.id);
  const manage = (
    <Link
      to="/crew/$botId"
      params={{ botId: bot.id }}
      search={{ tab: "routines" }}
      className="text-muted-foreground hover:text-foreground text-xs"
    >
      Manage
    </Link>
  );
  if (jobs.value === null) return null;
  return (
    <section aria-label="Routines" className="flex flex-col gap-2">
      <SectionHeader title="Routines" action={manage} />
      {mine.length === 0 ? (
        <EmptyState>No schedules yet.</EmptyState>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {mine.map((job) => (
            <li key={job.id} className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate" title={job.prompt}>
                {job.prompt}
              </span>
              <span className="text-muted-foreground shrink-0 text-xs">
                {!job.enabled
                  ? "Paused"
                  : job.once !== undefined && job.once !== null
                    ? `Once, ${formatWhen(job.once)}`
                    : (cronToText(job.schedule) ?? job.schedule)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
