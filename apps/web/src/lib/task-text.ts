/**
 * Plain words for background tasks, shared by the task pill and the task
 * cards: a title, an elapsed time, the one-line "what it's doing now", and
 * the pill's summary. Pure, so it is unit-tested.
 */
import type { TaskInfo } from "@spreissen/contracts";

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

/** How long a task ran (or has been running, against `now`). */
export function taskElapsed(task: Pick<TaskInfo, "createdAt" | "finishedAt">, now: number): string {
  return formatElapsed((task.finishedAt ?? now) - task.createdAt);
}

/** What the task is doing: its latest progress update, else its latest step. */
export function taskLatest(task: Pick<TaskInfo, "updates" | "lastStep">): string | undefined {
  const update = task.updates?.at(-1)?.text;
  return update ?? task.lastStep;
}

const STATUS_WORD = {
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Stopped",
} as const;

export const taskStatusWord = (status: TaskInfo["status"]): string => STATUS_WORD[status];

/** Settled tasks stay in the pill this long, so a finish is noticed. */
export const RECENT_MS = 10 * 60_000;

/** The tasks the pill shows: every running one, plus ones settled recently. */
export function pillTasks(tasks: readonly TaskInfo[], now: number): TaskInfo[] {
  return tasks.filter(
    (task) =>
      task.status === "running" || (task.finishedAt !== null && now - task.finishedAt < RECENT_MS),
  );
}

/** The collapsed pill's line: "2 tasks running", "1 task running · 1 done", "Task done". */
export function pillLabel(tasks: readonly TaskInfo[]): string {
  const running = tasks.filter((task) => task.status === "running").length;
  const settled = tasks.length - running;
  const failed = tasks.filter((task) => task.status === "failed").length;
  if (running > 0) {
    const head = `${running} ${running === 1 ? "task" : "tasks"} running`;
    return settled > 0 ? `${head} · ${settled} done` : head;
  }
  if (settled === 1)
    return failed === 1 ? "Task failed" : `Task ${STATUS_WORD[tasks[0]!.status].toLowerCase()}`;
  return failed > 0 ? `${settled} tasks finished · ${failed} failed` : `${settled} tasks finished`;
}
