/**
 * Projects (`mind.projects`), read and steered by the owner:
 *   GET    /api/projects[?bot=]   the owner's projects, newest change first
 *   PATCH  /api/projects/:id      { status?, done?, undone?, note? } — logged as the owner's
 *   DELETE /api/projects/:id
 * Bots start and update projects through their `project` tool. Another
 * owner's project answers exactly like a missing one.
 */
import { Value } from "typebox/value";
import { ProjectStatusSchema, type ProjectOwnerPatch } from "@spriessen/contracts";
import { queryOr, type RouteArgs } from "./types.ts";

const numbers = (value: unknown): boolean =>
  value === undefined || (Array.isArray(value) && value.every((n) => Number.isInteger(n)));

const patchOf = (body: Record<string, unknown>): ProjectOwnerPatch | undefined => {
  if (body.status !== undefined && !Value.Check(ProjectStatusSchema, body.status)) return undefined;
  if (!numbers(body.done) || !numbers(body.undone)) return undefined;
  if (body.note !== undefined && typeof body.note !== "string") return undefined;
  return body as ProjectOwnerPatch;
};

export async function projectRoutes(args: RouteArgs): Promise<boolean> {
  const { mind, json, path } = args;
  const method = args.req.method ?? "GET";
  if (path === "/api/projects" && method === "GET") {
    json(200, await mind.projects.list(args.owner, queryOr(args, "bot")));
    return true;
  }
  const one = /^\/api\/projects\/([^/]+)$/.exec(path);
  if (one === null) return false;
  const id = decodeURIComponent(one[1] ?? "");
  if (method === "DELETE") {
    const removed = await mind.projects.remove(args.owner, id);
    json(removed ? 200 : 404, removed ? { ok: true } : { error: "no such project" });
    return true;
  }
  if (method !== "PATCH") return false;
  const patch = patchOf(await args.readJson<Record<string, unknown>>(args.req));
  if (patch === undefined) {
    json(400, {
      error: "status is active, paused, done or dropped; done and undone are milestone numbers",
    });
    return true;
  }
  const outcome = await mind.projects.change(args.owner, id, patch, "owner");
  if (outcome === undefined) json(404, { error: "no such project" });
  else if (!outcome.ok) json(400, { error: outcome.error });
  else json(200, outcome.project);
  return true;
}
