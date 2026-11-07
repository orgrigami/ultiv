/**
 * Behaviour tests (`mind.evals`), owner-scoped like every route: another
 * owner's case or run answers exactly like a missing one.
 *   GET    /api/evals[?bot=]          the saved cases
 *   POST   /api/evals                 save a chat message as a case { sessionId, at, title?, expect? }
 *   PATCH  /api/evals/:id             { title?, expect? }
 *   DELETE /api/evals/:id
 *   POST   /api/evals/run             start a run { botId?, caseIds?, model? }
 *   GET    /api/evals/runs            the runs, newest first
 *   GET    /api/evals/runs/:id        one run with its results
 */
import { Value } from "typebox/value";
import { EvalExpectSchema, type EvalExpect } from "@spriessen/contracts";
import { errorOf, queryOr, type RouteArgs } from "./types.ts";

const statusOf = (cause: unknown): number =>
  (cause as { _tag?: string })._tag === "spriessen/NotFound" ? 404 : 400;

const expectOf = (value: unknown): EvalExpect | undefined | "bad" =>
  value === undefined ? undefined : Value.Check(EvalExpectSchema, value) ? value : "bad";

const strings = (value: unknown): string[] | undefined | "bad" =>
  value === undefined
    ? undefined
    : Array.isArray(value) && value.every((item) => typeof item === "string")
      ? value
      : "bad";

async function caseRoutes(args: RouteArgs, method: string): Promise<boolean> {
  const { mind, json, path } = args;
  if (path === "/api/evals" && method === "GET") {
    json(200, await mind.evals.list(args.owner, queryOr(args, "bot")));
    return true;
  }
  if (path === "/api/evals" && method === "POST") {
    const body = await args.readJson<Record<string, unknown>>(args.req);
    const expect = expectOf(body.expect);
    if (typeof body.sessionId !== "string" || typeof body.at !== "number" || expect === "bad") {
      json(400, { error: "sessionId, at (a message id) and a valid expect are required" });
      return true;
    }
    json(
      200,
      await mind.evals.capture(args.owner, {
        sessionId: body.sessionId,
        at: body.at,
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(expect !== undefined ? { expect } : {}),
      }),
    );
    return true;
  }
  const one = /^\/api\/evals\/([^/]+)$/.exec(path);
  if (one === null || one[1] === "run" || one[1] === "runs") return false;
  const id = decodeURIComponent(one[1] ?? "");
  if (method === "DELETE") {
    const removed = await mind.evals.remove(args.owner, id);
    json(removed ? 200 : 404, removed ? { ok: true } : { error: "no such test" });
    return true;
  }
  if (method !== "PATCH") return false;
  const body = await args.readJson<Record<string, unknown>>(args.req);
  const expect = expectOf(body.expect);
  if (expect === "bad" || (body.title !== undefined && typeof body.title !== "string")) {
    json(400, { error: "title must be text and expect must be valid" });
    return true;
  }
  json(
    200,
    await mind.evals.update(args.owner, id, {
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(expect !== undefined ? { expect } : {}),
    }),
  );
  return true;
}

async function runRoutes(args: RouteArgs, method: string): Promise<boolean> {
  const { mind, json, path } = args;
  if (path === "/api/evals/run" && method === "POST") {
    const body = await args.readJson<Record<string, unknown>>(args.req);
    const caseIds = strings(body.caseIds);
    if (
      caseIds === "bad" ||
      (body.botId !== undefined && typeof body.botId !== "string") ||
      (body.model !== undefined && typeof body.model !== "string")
    ) {
      json(400, { error: "botId and model are text, caseIds a list of ids" });
      return true;
    }
    json(
      200,
      await mind.evals.start(args.owner, {
        ...(typeof body.botId === "string" ? { botId: body.botId } : {}),
        ...(caseIds !== undefined ? { caseIds } : {}),
        ...(typeof body.model === "string" ? { model: body.model } : {}),
      }),
    );
    return true;
  }
  if (path === "/api/evals/runs" && method === "GET") {
    json(200, await mind.evals.runs(args.owner));
    return true;
  }
  const one = /^\/api\/evals\/runs\/([^/]+)$/.exec(path);
  if (one === null || method !== "GET") return false;
  const row = await mind.evals.getRun(args.owner, decodeURIComponent(one[1] ?? ""));
  json(row === undefined ? 404 : 200, row ?? { error: "no such run" });
  return true;
}

export async function evalRoutes(args: RouteArgs): Promise<boolean> {
  if (!args.path.startsWith("/api/evals")) return false;
  const method = args.req.method ?? "GET";
  try {
    return (await caseRoutes(args, method)) || (await runRoutes(args, method));
  } catch (cause) {
    args.json(statusOf(cause), { error: errorOf(cause) });
    return true;
  }
}
