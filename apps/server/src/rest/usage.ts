/**
 * GET /api/usage?profile=<id> — one bot's daily token spend (newest day
 * first, the last 30 days) plus its budget policy, for the Edit-bot dialog
 * and spend surfaces. Another owner's bot answers 404 like a missing one.
 */
import { type RouteArgs } from "./types.ts";

export async function usageRoutes(args: RouteArgs): Promise<boolean> {
  const match = args.path.match(/^\/api\/usage$/);
  if (match === null || (args.req.method ?? "GET") !== "GET") return false;
  const profileId = new URL(args.req.url ?? "", "http://local").searchParams.get("profile");
  if (profileId === null || profileId === "") {
    args.json(400, { error: "name a profile: /api/usage?profile=<id>" });
    return true;
  }
  const profile = await args.mind.profiles.get(args.owner, profileId);
  if (profile === undefined) {
    args.json(404, { error: "unknown bot" });
    return true;
  }
  const days = await args.mind.usage.of(args.owner, profileId);
  args.json(200, {
    profile: profileId,
    budget: profile.policies.dailyTokenBudget ?? null,
    today: days[0]?.tokens ?? 0,
    days,
  });
  return true;
}
