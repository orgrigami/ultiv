/**
 * Browser-takeover routes: the owner drives a bot's browser page when the
 * bot asked (a sign-in, a code, a CAPTCHA — `browser_session` op takeover).
 * The driving seat is the LIVE CAST: `GET /:id/cast` is a server-sent event
 * stream of screencast frames from the bot's browser (the one exception to
 * "signals, never payloads" — the payload IS the point), and `POST
 * /:id/cast/act` sends what the owner did (a tap, typing, a key, a scroll,
 * a url) into the page as REAL input events. The selector-by-selector act
 * route stays for older clients; Finish answers the bot's waiting call with
 * the page (the ask BLOCKS — browser/takeover.ts). A
 * takeover belongs to one of the caller's bots' conversations — another
 * owner's row answers 404 like a missing one.
 */
import { errorOf, type RouteArgs } from "./types.ts";
import { botOf, castActOf, holdsConversation as holds, serveCast } from "./browser-cast.ts";

/** The row enriched with the asking bot, for the Crew tab. */
const rowFor = async (
  args: RouteArgs,
  row: { id: string; conversationId: string; reason: string; openedAt: number },
) => ({ ...row, ...(await botOf(args, row.conversationId)) });

const ownedRow = (args: RouteArgs, id: string) => {
  const row = args.mind.browserTakeovers?.get(id);
  if (row === undefined) return undefined;
  return holds(args, row.conversationId) ? row : undefined;
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
    const mine = rows.filter((row) => holds(args, row.conversationId));
    json(200, { takeovers: await Promise.all(mine.map((row) => rowFor(args, row))) });
    return true;
  }
  const cast = path.match(/^\/api\/browser\/takeover\/([^/]+)\/cast$/);
  if (cast !== null && method === "GET") {
    const row = ownedRow(args, decodeURIComponent(cast[1] ?? ""));
    if (row === undefined) {
      json(404, { error: "that takeover is no longer open" });
      return true;
    }
    // The ask may close while the driver launches: then no stream starts.
    const takeovers = mind.browserTakeovers;
    await serveCast(args, row.conversationId, () => takeovers.get(row.id) !== undefined);
    return true;
  }
  const castAct = path.match(/^\/api\/browser\/takeover\/([^/]+)\/cast\/act$/);
  if (castAct !== null && method === "POST") {
    const row = ownedRow(args, decodeURIComponent(castAct[1] ?? ""));
    if (row === undefined) {
      json(404, { error: "that takeover is no longer open" });
      return true;
    }
    if (mind.browserCasts === undefined) {
      json(503, { error: "live browser casts are not available on this server" });
      return true;
    }
    try {
      const act = castActOf(await args.readJson<unknown>(req));
      if (act === undefined) {
        json(400, { error: 'send { a: "tap"|"type"|"key"|"scroll"|"nav"|"reload", … }' });
        return true;
      }
      await mind.browserCasts.act(row.conversationId, act);
      json(200, { ok: true });
    } catch (cause) {
      json(409, { error: errorOf(cause) });
    }
    return true;
  }
  const act = path.match(/^\/api\/browser\/takeover\/([^/]+)\/act$/);
  if (act !== null && method === "POST") {
    const row = ownedRow(args, decodeURIComponent(act[1] ?? ""));
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
      const input:
        | { kind: "click"; selector: string }
        | { kind: "type"; selector: string; text: string }
        | { kind: "press"; key: string }
        | { kind: "refresh" }
        | "bad" =
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
    const row = ownedRow(args, decodeURIComponent(finish[1] ?? ""));
    if (row === undefined) {
      json(404, { error: "that takeover is no longer open" });
      return true;
    }
    // The cast stops first: its viewport pin lifts so the waiting call
    // reads the page as the browser normally stands.
    await mind.browserCasts?.stop(row.conversationId).catch(() => undefined);
    await mind.browserTakeovers.finish(row.id);
    json(200, { ok: true });
    return true;
  }
  const remove = path.match(/^\/api\/browser\/takeover\/([^/]+)$/);
  if (remove !== null && method === "DELETE") {
    const row = ownedRow(args, decodeURIComponent(remove[1] ?? ""));
    if (row === undefined) {
      json(404, { error: "that takeover is no longer open" });
      return true;
    }
    await mind.browserCasts?.stop(row.conversationId).catch(() => undefined);
    await mind.browserTakeovers.cancel(row.id);
    json(200, { ok: true });
    return true;
  }
  return false;
}
