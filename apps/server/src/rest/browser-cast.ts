/**
 * The live cast over REST, shared by the takeover routes (the owner DRIVES)
 * and the browser-session routes (the owner WATCHES): one server-sent event
 * stream of screencast frames per viewer — the one exception to "signals,
 * never payloads": the payload IS the point — and the owner's acts checked
 * and bounded before they are typed into a page (never logged).
 */
import { errorOf, type RouteArgs } from "./types.ts";
import type { CastAct } from "@spriessen/ext";
import { can } from "./can.ts";

/** The caller may act on this conversation: the can() decision, never a label comparison. */
export const holdsConversation = (args: RouteArgs, conversationId: string): boolean => {
  const scope = args.mind.profiles.scopeOf(conversationId);
  return (
    scope !== undefined &&
    can(args.owner, "change", { type: "chat", owner: scope.owner, id: conversationId })
  );
};

/** The asking bot of a conversation, for the owner's lists. */
export const botOf = async (
  args: RouteArgs,
  conversationId: string,
): Promise<{ profileId: string | null; botName: string }> => {
  const scope = args.mind.profiles.scopeOf(conversationId);
  const bot =
    scope === undefined
      ? undefined
      : await args.mind.profiles.get(scope.owner, scope.profileId).catch(() => undefined);
  return { profileId: scope?.profileId ?? null, botName: bot?.name ?? "A bot" };
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

const navOf = (url: unknown): CastAct | undefined => {
  if (typeof url !== "string" || url.length > 2_000) return undefined;
  if (url === "about:blank") return { a: "nav", url };
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? { a: "nav", url }
      : undefined;
  } catch {
    return undefined;
  }
};

/** The owner's act, checked and bounded — it is typed into a page, never logged. */
export const castActOf = (body: unknown): CastAct | undefined => {
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
    return typeof act.key === "string" && (KNOWN_KEYS.has(act.key) || act.key.length === 1)
      ? { a: "key", key: act.key }
      : undefined;
  }
  if (act.a === "scroll") {
    const dx = finite(act.dx, -20_000, 20_000);
    const dy = finite(act.dy, -20_000, 20_000);
    return dx !== undefined && dy !== undefined ? { a: "scroll", dx, dy } : undefined;
  }
  if (act.a === "nav") return navOf(act.url);
  if (act.a === "reload") return { a: "reload" };
  return undefined;
};

/**
 * One SSE subscriber over a conversation's cast: frames out, backpressure-
 * safe. `stillWanted` is re-checked once the cast is up: the reason to watch
 * (an open takeover, a live session) may have closed while the driver
 * launched — then the viewer is released and the stream answers 404.
 */
export const streamCast = async (
  args: RouteArgs,
  conversationId: string,
  stillWanted: () => boolean,
): Promise<void> => {
  const { res } = args;
  const casts = args.mind.browserCasts;
  if (casts === undefined) {
    args.json(503, { error: "live browser casts are not available on this server" });
    return;
  }
  const session = await casts.for(conversationId);
  // The viewer may have left during the launch ('close' already fired), or
  // the reason to watch closed: release now, or the cast never winds down.
  if (args.req.destroyed || res.destroyed || !stillWanted()) {
    session.release();
    if (!res.destroyed && !res.headersSent)
      args.json(404, { error: "that view is no longer open" });
    return;
  }
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

/** The GET handler around streamCast: once the stream starts, errors end it, never rethrow. */
export const serveCast = async (
  args: RouteArgs,
  conversationId: string,
  stillWanted: () => boolean,
): Promise<void> => {
  try {
    await streamCast(args, conversationId, stillWanted);
  } catch (cause) {
    if (!args.res.headersSent) args.json(503, { error: errorOf(cause) });
    else args.res.end();
  }
};
