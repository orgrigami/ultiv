/**
 * How many background tasks a bot runs at once. The bot's own policy
 * (`policies.maxRunningTasks`, Edit bot) outranks the workspace default
 * stored in Settings, which outranks `SPRIESSEN_MAX_RUNNING_TASKS`, which
 * outranks the built-in default. Tasks over the limit wait in the bot's
 * queue (queue.ts) and start as slots free.
 */
import { readEnv } from "@spriessen/core";
import { TASK_LIMIT_DEFAULT, TASK_LIMIT_MAX, type TaskSettings } from "@spriessen/contracts";

/** A whole number within 1..TASK_LIMIT_MAX, else null (unset or out of range). */
const valid = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= TASK_LIMIT_MAX
    ? value
    : null;

/** SPRIESSEN_MAX_RUNNING_TASKS, clamped into range; null when unset or blank. */
export const envTaskLimit = (): number | null => {
  const raw = readEnv("MAX_RUNNING_TASKS")?.trim() ?? "";
  if (raw === "") return null;
  const value = Math.floor(Number(raw));
  return Number.isFinite(value) ? Math.min(TASK_LIMIT_MAX, Math.max(1, value)) : null;
};

/** The workspace default and where it comes from (GET /api/settings/tasks). */
export const workspaceTaskLimitOf = (stored: number | null | undefined): TaskSettings => {
  const db = valid(stored);
  if (db !== null) return { maxRunningTasks: db, source: "db" };
  const env = envTaskLimit();
  if (env !== null) return { maxRunningTasks: env, source: "env" };
  return { maxRunningTasks: TASK_LIMIT_DEFAULT, source: "default" };
};

/** One bot's limit: its own policy, else the workspace default. */
export const taskLimitOf = (
  policy: number | null | undefined,
  stored: number | null | undefined,
): number => valid(policy) ?? workspaceTaskLimitOf(stored).maxRunningTasks;

/** Queued tasks one bot may hold at once; a spawn beyond it is refused. */
export const MAX_QUEUED_TASKS = 20;
