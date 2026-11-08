/**
 * GET /api/settings/tasks — how many background tasks a bot runs at once by
 * default, and where that comes from: stored in Settings ("db"),
 * SPRIESSEN_MAX_RUNNING_TASKS ("env") or built in ("default"). A bot's own
 * limit (Edit bot) outranks it. PUT { maxRunningTasks } stores it (1–10);
 * null clears it. A change starts queued work that now fits at once.
 */
import { workspaceTaskLimitOf } from "@spriessen/mind";
import { errorOf, type RouteArgs } from "./types.ts";

const current = async (args: RouteArgs) =>
  workspaceTaskLimitOf(await args.mind.profiles.workspaceTaskLimit());

export async function taskSettingsRoutes(args: RouteArgs): Promise<boolean> {
  if (args.path !== "/api/settings/tasks") return false;
  const method = args.req.method ?? "GET";
  if (method === "GET") {
    args.json(200, await current(args));
    return true;
  }
  if (method !== "PUT") return false;
  try {
    const body = await args.readJson<{ maxRunningTasks?: unknown } | null>(args.req);
    const value = body?.maxRunningTasks ?? null;
    if (value !== null && typeof value !== "number") {
      args.json(400, { error: "send { maxRunningTasks: <number> } — or null to clear it" });
      return true;
    }
    await args.mind.profiles.setWorkspaceTaskLimit(value);
    void args.mind.tasks.refill().catch((cause: unknown) => {
      console.error("task refill failed:", cause);
    });
    args.json(200, await current(args));
  } catch (cause) {
    args.json(400, { error: errorOf(cause) });
  }
  return true;
}
