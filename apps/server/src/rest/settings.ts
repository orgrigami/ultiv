/**
 * GET /api/settings/model — the workspace default and where it is set: the
 * stored setting ("db") supersedes the SPRIESSEN_MODEL environment ("env");
 * both unset = null, and there is no default. PUT stores {ref, effort} (or
 * null / {ref: null} to clear, which hands the default back to the env);
 * the ref must be in the live catalog. Owner-scoped like every route. A new
 * default reaches new chats at once, and the owner's chats that have NO
 * model (made before any default existed, which fail every turn) take it
 * too; a chat with a model of its own keeps it.
 */
import { Effect } from "effect";
import { InvalidInput } from "@spriessen/core";
import { errorOf, type RouteArgs } from "./types.ts";

/** Give the owner's model-less chats the (new) workspace default; best effort per chat. */
export const adoptDefault = async (args: RouteArgs): Promise<number> => {
  const { mind } = args;
  let adopted = 0;
  for (const row of await mind.profiles.listSessions(args.owner)) {
    try {
      const key = await mind.profiles.keyOfRow(row);
      const conversationId = await Effect.runPromise(mind.converse.conversationIdOf(key));
      if (conversationId === undefined) continue;
      const chat = await Effect.runPromise(mind.converse.open(conversationId));
      if (chat === undefined) continue;
      if ((await Effect.runPromise(mind.converse.agentOf(chat))).model !== null) continue;
      await Effect.runPromise(mind.converse.configure(chat, { model: null }));
      adopted += 1;
    } catch {
      // One stale chat never blocks the rest.
    }
  }
  return adopted;
};

const defaultOf = async (args: RouteArgs): Promise<unknown> => {
  const stored = await args.mind.profiles.workspaceDefaultModel();
  if (stored !== null) {
    return { defaultModel: { ref: stored.ref, effort: stored.effort, source: "db" } };
  }
  const env = args.mind.models.preferredRef();
  return { defaultModel: env !== null ? { ref: env, effort: "", source: "env" } : null };
};

/** The stored fallback for failed task runs (null = none); no env stands in. */
const fallbackOf = async (args: RouteArgs): Promise<unknown> => ({
  fallbackModel: await args.mind.profiles.workspaceFallbackModel(),
});

/** PUT body {ref, effort} → {ref, effort} | null; the ref must be in the catalog. */
const readModelBody = async (
  args: RouteArgs,
): Promise<{ ref: string; effort: string } | null | "bad"> => {
  const body = await args.readJson<{ ref?: unknown; effort?: unknown }>(args.req);
  if (body === null || body.ref === null || body.ref === undefined) return null;
  const ref = typeof body.ref === "string" ? body.ref.trim() : "";
  const effort = typeof body.effort === "string" ? body.effort.trim() : "";
  if (ref === "") return "bad";
  // The owner picks from the picker; this only catches drift. An empty
  // catalog (first boot, offline) cannot judge: the ref is kept.
  if (args.mind.models.list().length > 0 && args.mind.models.find(ref) === undefined) {
    throw new InvalidInput({ reason: `unknown model "${ref}" — it is not in the live catalog` });
  }
  return { ref, effort };
};

export async function settingsRoutes(args: RouteArgs): Promise<boolean> {
  const method = args.req.method ?? "GET";
  if (args.path === "/api/settings/fallback-model") {
    if (method === "GET") {
      args.json(200, await fallbackOf(args));
      return true;
    }
    if (method === "PUT") {
      try {
        const model = await readModelBody(args);
        if (model === "bad") {
          args.json(400, { error: "send { ref, effort } — or null to clear the fallback" });
          return true;
        }
        await args.mind.profiles.setWorkspaceFallbackModel(model);
        args.json(200, await fallbackOf(args));
      } catch (cause) {
        args.json(409, { error: errorOf(cause) });
      }
      return true;
    }
    return false;
  }
  if (args.path !== "/api/settings/model") return false;
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
      await adoptDefault(args);
      args.json(200, await defaultOf(args));
      return true;
    } catch (cause) {
      args.json(409, { error: errorOf(cause) });
      return true;
    }
  }
  return false;
}
