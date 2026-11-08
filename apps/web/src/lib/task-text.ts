/**
 * Plain words for background tasks, the same on every surface (the task line
 * in the chat, the header's task list, Now, a bot's Work tab, the task
 * sheet): a title, a status word, an elapsed time, the one-line "what it's
 * doing now", and the header chip's count. Pure, so it is unit-tested.
 */
import type { TaskInfo } from "@spriessen/contracts";
import { plural } from "./plural.ts";

const TITLE_CHARS = 40;

/** The bot's title, else the first line of the brief, ≤40 chars. */
export function taskTitle(task: Pick<TaskInfo, "title" | "prompt">): string {
  const own = task.title?.trim() ?? "";
  const source = own !== "" ? own : (task.prompt.split("\n")[0] ?? "").trim();
  if (source === "") return "Background task";
  return source.length > TITLE_CHARS ? `${source.slice(0, TITLE_CHARS - 1).trimEnd()}…` : source;
}

/** "45s", "3m 05s", "1h 12m". */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** How long a task's latest run took (or has been running, against `now`); a queued one waits. */
export function taskElapsed(
  task: Pick<TaskInfo, "createdAt" | "startedAt" | "finishedAt">,
  now: number,
): string {
  return formatElapsed((task.finishedAt ?? now) - (task.startedAt ?? task.createdAt));
}

/** What the task is doing: its latest progress update, else its latest step. */
export function taskLatest(task: Pick<TaskInfo, "updates" | "lastStep">): string | undefined {
  const update = task.updates?.at(-1)?.text;
  return update ?? task.lastStep;
}

const STATUS_WORD = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Stopped",
} as const;

export const taskStatusWord = (status: TaskInfo["status"]): string => STATUS_WORD[status];

/** Running or waiting for a slot: work still in flight. */
export const isLive = (task: Pick<TaskInfo, "status">): boolean =>
  task.status === "running" || task.status === "queued";

/**
 * The one meta line every task row shows under (or instead of) its title:
 * "Running · 3m 05s · Searching the web", "Queued · waits for a free slot",
 * "Done · 6m 56s". A continued task says which run it is on.
 */
export function taskMeta(
  task: Pick<
    TaskInfo,
    "status" | "createdAt" | "startedAt" | "finishedAt" | "runs" | "updates" | "lastStep"
  >,
  now: number,
): string {
  const parts = [taskStatusWord(task.status)];
  if (task.status === "queued") parts.push("waits for a free slot");
  else parts.push(taskElapsed(task, now));
  if ((task.runs ?? 1) > 1) parts.push(`run ${task.runs}`);
  const latest = task.status === "running" ? taskLatest(task) : undefined;
  if (latest !== undefined) parts.push(latest);
  return parts.join(" · ");
}

/** The header chip's words: "2 running", "1 running · 1 queued", "3 queued". */
export function chipLabel(tasks: readonly Pick<TaskInfo, "status">[]): string {
  const running = tasks.filter((task) => task.status === "running").length;
  const queued = tasks.filter((task) => task.status === "queued").length;
  const parts = [
    ...(running > 0 ? [`${running} running`] : []),
    ...(queued > 0 ? [`${queued} queued`] : []),
  ];
  return parts.join(" · ");
}

/** The chip's spoken label: "2 background tasks running, 1 queued". */
export function chipAria(tasks: readonly Pick<TaskInfo, "status">[]): string {
  const running = tasks.filter((task) => task.status === "running").length;
  const queued = tasks.filter((task) => task.status === "queued").length;
  const head = `${running} background ${plural(running, "task", "tasks")} running`;
  return queued > 0 ? `${head}, ${queued} queued. Show them` : `${head}. Show them`;
}
