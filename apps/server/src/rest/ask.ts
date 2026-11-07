/**
 * The ask seam: how a route asks the ONE permission check. Loads the org
 * view (members, teams) and hands it to `can()`, so route code never
 * compares roles or homes itself — it asks `may()` and answers a missing
 * item on a refusal.
 */
import type { Action, Resource } from "./can.ts";
import { can } from "./can.ts";
import type { RouteArgs } from "./types.ts";

export const may = async (
  args: RouteArgs,
  action: Action,
  resource: Resource,
): Promise<boolean> => {
  const view = await args.mind.org.view();
  return can(args.owner, action, resource, view);
};
