/**
 * Rows for the Routines page. Each leads with what the routine does and when,
 * in plain words; the raw cron / URL / method sit behind "Details" for
 * people who need them (with copy buttons).
 */
import { CopyIcon, Trash2Icon } from "lucide-react";
import type { CronJobInfo, SensorInfo } from "@spreissen/contracts";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DevDetails } from "@/components/ui/dev-details";
import { writeClipboard } from "@/lib/clipboard";
import { cronToText } from "@/lib/cron-text";
import { formatDivider, formatWhen } from "@/lib/format";
import { notifyError } from "@/lib/notify";

export const when = (at: number | null): string => (at === null ? "never" : formatWhen(at));

/** "Ran 3 times, last 9:15 PM" instead of "fired ×3". */
export const runs = (count: number, last: number | null): string =>
  count === 0
    ? "Hasn't run yet"
    : `Ran ${count === 1 ? "once" : `${count} times`}, last ${when(last)}`;

/** What a routine does when its bot is mid-reply ("steer" is the default, unlabelled). */
export const BUSY_LABEL: Record<string, string> = {
  followUp: "Waits its turn",
  reject: "Skips if busy",
};

export async function copyText(text: string, what = "Copied"): Promise<void> {
  try {
    await writeClipboard(text);
    toast.success(what);
  } catch (cause) {
    notifyError("Couldn't copy", cause);
  }
}

/** A labelled raw value with a copy button, for Details. */
export function RawValue({
  label,
  value,
  shown,
}: {
  label: string;
  value: string;
  shown?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="shrink-0">{label}</span>
      <code
        className="bg-muted text-foreground min-w-0 truncate rounded-md px-1.5 py-0.5"
        title={shown ?? value}
      >
        {shown ?? value}
      </code>
      <Button
        variant="ghost"
        size="icon-xs"
        className="shrink-0"
        aria-label={`Copy ${label.replace(/:$/, "").toLowerCase()}`}
        onClick={() => void copyText(value)}
      >
        <CopyIcon />
      </Button>
    </div>
  );
}

/** Row frame: content on the left, a confirmed delete on the right. */
export function RoutineRow({
  children,
  what,
  warning,
  onDelete,
}: {
  children: React.ReactNode;
  what: string;
  warning: string;
  onDelete: () => Promise<void>;
}) {
  return (
    <li className="flex items-start gap-2 px-3 py-2.5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">{children}</div>
      <ConfirmDialog title={`Delete ${what}?`} warning={warning} onConfirm={onDelete}>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground -mr-1 shrink-0"
          aria-label={`Delete ${what}`}
        >
          <Trash2Icon />
        </Button>
      </ConfirmDialog>
    </li>
  );
}

/** Second line: bot name and status badges. */
export function Meta({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
      {children}
    </div>
  );
}

function scheduleText(job: CronJobInfo): string {
  if (job.once !== undefined && job.once !== null) return `Once, ${formatDivider(job.once)}`;
  return cronToText(job.schedule) ?? `Custom schedule: ${job.schedule}`;
}

export function ScheduleRow({
  job,
  bot,
  onDelete,
}: {
  job: CronJobInfo;
  bot: string;
  onDelete: () => Promise<void>;
}) {
  const recurring = job.once === undefined || job.once === null;
  return (
    <RoutineRow
      what="schedule"
      warning="The bot will no longer be woken by it."
      onDelete={onDelete}
    >
      <p className="text-sm font-medium">{scheduleText(job)}</p>
      <p className="line-clamp-2 text-sm break-words" title={job.prompt}>
        {job.prompt}
      </p>
      <Meta>
        <span>{bot}</span>
        {!job.enabled && <Badge variant="secondary">Off</Badge>}
        {job.whenBusy !== undefined && job.whenBusy !== "steer" && (
          <Badge variant="outline">{BUSY_LABEL[job.whenBusy] ?? job.whenBusy}</Badge>
        )}
        {job.failures > 0 && <Badge variant="destructive">Failed {job.failures}×</Badge>}
      </Meta>
      <p className="text-muted-foreground text-xs">
        {runs(job.fireCount ?? 0, job.lastFiredAt ?? null)}
        {job.lastError !== null && job.lastError !== "" ? `. Last error: ${job.lastError}` : ""}
      </p>
      {recurring && (
        <DevDetails>
          <RawValue label="Cron:" value={job.schedule} />
          <p>In {bot}'s time zone.</p>
        </DevDetails>
      )}
    </RoutineRow>
  );
}

function sensorText(sensor: SensorInfo): string {
  const matching = sensor.match !== "" ? ` matching “${sensor.match}”` : "";
  if (sensor.kind === "calendar") {
    return `${sensor.leadMinutes} min before calendar events${matching}`;
  }
  if (sensor.kind === "rss") return `New posts in a feed${matching}`;
  return `When a web page changes${matching}`;
}

export function SensorRow({
  sensor,
  bot,
  onDelete,
}: {
  sensor: SensorInfo;
  bot: string;
  onDelete: () => Promise<void>;
}) {
  const failed = sensor.lastError !== null && sensor.lastError !== "";
  return (
    <RoutineRow
      what="watch"
      warning="The bot will no longer be woken by these events."
      onDelete={onDelete}
    >
      <p className="text-sm font-medium">{sensorText(sensor)}</p>
      <Meta>
        <span>{bot}</span>
        {!sensor.enabled && <Badge variant="secondary">Off</Badge>}
        {failed && <Badge variant="destructive">Error</Badge>}
      </Meta>
      <p className="text-muted-foreground text-xs">
        {runs(sensor.fireCount, sensor.lastFiredAt)}
        {failed ? `. Last error: ${sensor.lastError}` : ""}
      </p>
      {sensor.url !== null && (
        <DevDetails>
          <RawValue label="URL:" value={sensor.url} />
        </DevDetails>
      )}
    </RoutineRow>
  );
}
