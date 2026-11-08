/**
 * Browser-takeover routes: the owner drives a bot's browser page when the
 * bot asked (a sign-in, a code, a CAPTCHA — `browser_session` op takeover).
 * One act at a time, each answer carrying the fresh screenshot (no stream,
 * no timer); Finish wakes the bot with the page. A takeover belongs to one
 * of the caller's bots' conversations — another owner's row answers 404
 * like a missing one.
 */
import { errorOf, type RouteArgs } from "./types.ts";
import type { TakeoverAct } from "@spriessen/ext";

/** The row enriched with the asking bot, for the Crew tab. */
const rowFor = async (
  args: RouteArgs,
  row: { id: string; conversationId: string; reason: string; openedAt: number },
) => {
  const scope = args.mind.profiles.scopeOf(row.conversationId);
  const bot =
    scope === undefined
      ? undefined
      : await args.mind.profiles.get(scope.owner, scope.profileId).catch(() => undefined);
  return {
    ...row,
    profileId: scope?.profileId ?? null,
    botName: bot?.name ?? "A bot",
  };
};

const ownedRow = async (args: RouteArgs, id: string) => {
  const row = args.mind.browserTakeovers?.get(id);
  if (row === undefined) return undefined;
  const scope = args.mind.profiles.scopeOf(row.conversationId);
  if (scope === undefined || scope.owner !== args.owner) return undefined;
  return row;
};

export async function takeoverRoutes(args: RouteArgs): Promise<boolean> {
  const { req, mind, path, json } = args;
  const method = req.method ?? "GET";
  if (mind.browserTakeovers === undefined) {
    if (path.startsWith("/api/browser/takeover")) {
      json(503, { error: "browser takeovers are not available on this server" });
      return true;
    }
    return false;
  }
  if (path === "/api/browser/takeover" && method === "GET") {
    const rows = mind.browserTakeovers.list();
    const mine = rows.filter((row) => {
      const scope = mind.profiles.scopeOf(row.conversationId);
      return scope !== undefined && scope.owner === args.owner;
    });
    json(200, { takeovers: await Promise.all(mine.map((row) => rowFor(args, row))) });
    return true;
  }
  const act = path.match(/^\/api\/browser\/takeover\/([^/]+)\/act$/);
  if (act !== null && method === "POST") {
    const row = await ownedRow(args, decodeURIComponent(act[1] ?? ""));
    if (row === undefined) {
      json(404, { error: "that takeover is no longer open" });
      return true;
    }
    try {
      const body = await args.readJson<{
        kind?: unknown;
        selector?: unknown;
        text?: unknown;
        key?: unknown;
      } | null>(req);
      const kind = body?.kind;
      const selector = typeof body?.selector === "string" ? body.selector : "";
      const input: TakeoverAct | "bad" =
        kind === "click" && selector !== ""
          ? { kind: "click", selector }
          : kind === "type" && selector !== ""
            ? { kind: "type", selector, text: typeof body?.text === "string" ? body.text : "" }
            : kind === "press"
              ? { kind: "press", key: typeof body?.key === "string" ? body.key : "Enter" }
              : kind === "refresh"
                ? { kind: "refresh" }
                : "bad";
      if (input === "bad") {
        json(400, { error: 'send { kind: "click"|"type"|"press"|"refresh", … }' });
        return true;
      }
      json(200, await mind.browserTakeovers.act(row.id, input));
    } catch (cause) {
      json(409, { error: errorOf(cause) });
    }
    return true;
  }
  const finish = path.match(/^\/api\/browser\/takeover\/([^/]+)\/finish$/);
  if (finish !== null && method === "POST") {
    const row = await ownedRow(args, decodeURIComponent(finish[1] ?? ""));
    if (row === undefined) {
      json(404, { error: "that takeover is no longer open" });
      return true;
    }
    await mind.browserTakeovers.finish(row.id);
    json(200, { ok: true });
    return true;
  }
  const remove = path.match(/^\/api\/browser\/takeover\/([^/]+)$/);
  if (remove !== null && method === "DELETE") {
    const row = await ownedRow(args, decodeURIComponent(remove[1] ?? ""));
    if (row === undefined) {
      json(404, { error: "that takeover is no longer open" });
      return true;
    }
    await mind.browserTakeovers.cancel(row.id);
    json(200, { ok: true });
    return true;
  }
  return false;
}
