/**
 * GET /api/settings/pause — is the crew paused. PUT { paused: boolean }
 * sets it: while on, no background task starts (spawns queue; resuming
 * starts what fits) and routine fires are held with "held" receipts instead
 * of waking anyone (pause.ts). Chats with the owner keep working.
 */
import { errorOf, type RouteArgs } from "./types.ts";

export async function pauseRoutes(args: RouteArgs): Promise<boolean> {
  if (args.path !== "/api/settings/pause") return false;
  const method = args.req.method ?? "GET";
  const current = async () => ({ paused: await args.mind.profiles.workspacePaused() });
  if (method === "GET") {
    args.json(200, await current());
    return true;
  }
  if (method !== "PUT") return false;
  try {
    const body = await args.readJson<{ paused?: unknown } | null>(args.req);
    if (typeof body?.paused !== "boolean") {
      args.json(400, { error: "send { paused: true } or { paused: false }" });
      return true;
    }
    await args.mind.profiles.setWorkspacePaused(body.paused);
    if (body.paused === false) {
      // Resume starts the queued work that now fits, at once.
      void args.mind.tasks.refill().catch((cause: unknown) => {
        console.error("task refill failed:", cause);
      });
    }
    args.json(200, await current());
  } catch (cause) {
    args.json(400, { error: errorOf(cause) });
  }
  return true;
}
