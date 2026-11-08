/**
 * Browser-takeover routes: the owner drives a bot's browser page when the
 * bot asked (a sign-in, a code, a CAPTCHA — `browser_session` op takeover).
 * The driving seat is the LIVE CAST: `GET /:id/cast` is a server-sent event
 * stream of screencast frames from the bot's browser (the one exception to
 * "signals, never payloads" — the payload IS the point), and `POST
 * /:id/cast/act` sends what the owner did (a tap, typing, a key, a scroll,
 * a url) into the page as REAL input events. The selector-by-selector act
 * route stays for older clients; Finish wakes the bot with the page. A
 * takeover belongs to one of the caller's bots' conversations — another
 * owner's row answers 404 like a missing one.
 */
import type { ServerResponse } from "node:http";
import { errorOf, type RouteArgs } from "./types.ts";
import type { CastAct } from "@spriessen/ext";
import { can } from "./can.ts";

/** The caller holds this conversation's controls: the can() decision, never a label comparison. */
const holds = (args: RouteArgs, conversationId: string): boolean => {
  const scope = args.mind.profiles.scopeOf(conversationId);
  return (
    scope !== undefined &&
    can(args.owner, "change", { type: "chat", owner: scope.owner, id: conversationId })
  );
};

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

const ownedRow = (args: RouteArgs, id: string) => {
  const row = args.mind.browserTakeovers?.get(id);
  if (row === undefined) return undefined;
  return holds(args, row.conversationId) ? row : undefined;
};

/** Named keys the cast driver knows a keycode for (mirrors KEYCODES there). */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Escape",
  "ArrowLeft",
  "ArrowUp",
  "ArrowRight",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

const finite = (value: unknown, min: number, max: number): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value >= min && value <= max ? value : undefined;
};

/** The owner's act, checked and bounded — it is typed into a page, never logged. */
const castActOf = (body: unknown): CastAct | undefined => {
  if (typeof body !== "object" || body === null) return undefined;
  const act = body as Record<string, unknown>;
  if (act.a === "tap") {
    const x = finite(act.x, 0, 10_000);
    const y = finite(act.y, 0, 10_000);
    const id = typeof act.id === "string" ? act.id.slice(0, 40) : "";
    return x !== undefined && y !== undefined ? { a: "tap", x, y, id } : undefined;
  }
  if (act.a === "type") {
    return typeof act.text === "string" && act.text.length > 0 && act.text.length <= 5_000
      ? { a: "type", text: act.text }
      : undefined;
  }
  if (act.a === "key") {
    return typeof act.key === "string" &&
      (KNOWN_KEYS.has(act.key) || (act.key.length === 1 && !KNOWN_KEYS.has(act.key)))
      ? { a: "key", key: act.key }
      : undefined;
  }
  if (act.a === "scroll") {
    const dx = finite(act.dx, -20_000, 20_000);
    const dy = finite(act.dy, -20_000, 20_000);
    return dx !== undefined && dy !== undefined ? { a: "scroll", dx, dy } : undefined;
  }
  if (act.a === "nav") {
    if (typeof act.url !== "string" || act.url.length > 2_000) return undefined;
    if (act.url === "about:blank") return { a: "nav", url: act.url };
    try {
      const url = new URL(act.url);
      return url.protocol === "http:" || url.protocol === "https:"
        ? { a: "nav", url: act.url }
        : undefined;
    } catch {
      return undefined;
    }
  }
  if (act.a === "reload") return { a: "reload" };
  return undefined;
};

/** One SSE subscriber over a conversation's cast: frames out, backpressure-safe. */
const streamCast = async (args: RouteArgs, conversationId: string): Promise<void> => {
  const { res } = args;
  const casts = args.mind.browserCasts;
  if (casts === undefined) {
    args.json(503, { error: "live browser casts are not available on this server" });
    return;
  }
  const session = await casts.for(conversationId);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  // Padding first: a proxy that buffers the first kilobyte must not hold the
  // stream hostage — headers and the retry hint go out now.
  res.write(`:${" ".repeat(2048)}\nretry: 3000\n\n`);
  const send = (event: string, data: unknown): void => {
    if (res.destroyed || res.writableLength > 600_000) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const off = session.subscribe((event) => {
    if (event.kind === "frame") {
      const { id, data, mime, w, h, url, title } = event.frame;
      send("frame", { id, data, mime, w, h, url, title });
    } else if (event.kind === "ready") {
      send("ready", { ok: true });
    } else if (event.kind === "error") {
      send("cast-error", { error: event.error });
    } else {
      send("closed", { reason: event.reason });
      res.end();
    }
  });
  const keepalive = setInterval(() => {
    if (!res.destroyed && res.writableLength < 600_000) res.write(": keepalive\n\n");
  }, 15_000);
  keepalive.unref?.();
  res.on("close", () => {
    clearInterval(keepalive);
    off();
    session.release();
  });
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
    // Once the stream starts, errors end the response — they never rethrow
    // into the handler's JSON catch (headers are already out).
    try {
      await streamCast(args, row.conversationId);
    } catch (cause) {
      if (!args.res.headersSent) json(503, { error: errorOf(cause) });
      else args.res.end();
    }
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
    // The cast stops first: its viewport pin lifts so the wake reads the
    // page as the browser normally stands.
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
