/**
 * GET /api/tools — the installed tool catalog for the allowlist editor:
 * every tool's name and one-line description, sourced from the same
 * entity-parts union the server check reads (`mind.describe()`), never a
 * second catalog. Carries no owner data (names and descriptions only); the
 * auth gate still requires a signed-in account, like every route.
 */
import type { RouteArgs } from "./types.ts";

export async function toolRoutes(args: RouteArgs): Promise<boolean> {
  if (args.path !== "/api/tools" || args.req.method !== "GET") return false;
  args.json(200, args.mind.describe().catalog);
  return true;
}
