/**
 * GET /api/settings/model — the workspace default and where it is set: the
 * stored setting ("db") supersedes the SPRIESSEN_MODEL environment ("env");
 * both unset = null, and there is no default. PUT stores {ref, effort} (or
 * null / {ref: null} to clear, which hands the default back to the env);
 * the ref must be in the live catalog. Owner-scoped like every route.
 */
import { errorOf, type RouteArgs } from "./types.ts";

const defaultOf = async (args: RouteArgs): Promise<unknown> => {
  const stored = await args.mind.profiles.workspaceDefaultModel();
  if (stored !== null) {
    return { defaultModel: { ref: stored.ref, effort: stored.effort, source: "db" } };
  }
  const env = args.mind.models.preferredRef();
  return { defaultModel: env !== null ? { ref: env, effort: "", source: "env" } : null };
};

export async function settingsRoutes(args: RouteArgs): Promise<boolean> {
  if (args.path !== "/api/settings/model") return false;
  const method = args.req.method ?? "GET";
  if (method === "GET") {
    args.json(200, await defaultOf(args));
    return true;
  }
  if (method === "PUT") {
    try {
      const body = await args.readJson<{ ref?: unknown; effort?: unknown }>(args.req);
      if (body === null || body.ref === null || body.ref === undefined) {
        await args.mind.profiles.setWorkspaceDefaultModel(null);
        args.json(200, await defaultOf(args));
        return true;
      }
      const ref = typeof body.ref === "string" ? body.ref.trim() : "";
      const effort = typeof body.effort === "string" ? body.effort.trim() : "";
      if (ref === "") {
        args.json(400, { error: "send { ref, effort } — or null to clear the stored default" });
        return true;
      }
      // The owner picks from the picker; this only catches drift. An empty
      // catalog (first boot, offline) cannot judge: the ref is kept.
      if (args.mind.models.list().length > 0 && args.mind.models.find(ref) === undefined) {
        args.json(409, { error: `unknown model "${ref}" — it is not in the live catalog` });
        return true;
      }
      await args.mind.profiles.setWorkspaceDefaultModel({ ref, effort });
      args.json(200, await defaultOf(args));
      return true;
    } catch (cause) {
      args.json(409, { error: errorOf(cause) });
      return true;
    }
  }
  return false;
}
