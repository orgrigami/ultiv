/**
 * The live cast over REST, shared by the takeover routes (the owner DRIVES)
 * and the browser-session routes (the owner WATCHES): one server-sent event
 * stream of screencast frames per viewer — the one exception to "signals,
 * never payloads": the payload IS the point — and the owner's acts checked
 * and bounded before they are typed into a page (never logged).
 */
import { errorOf, type RouteArgs } from "./types.ts";
import type { CastAct, CastFrame, CastOptions } from "@spriessen/ext";

/** Bytes a viewer's socket may hold before frames start to wait (newest only). */
const FRAME_BACKLOG = 400_000;
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

/** Named keys the broker knows a keycode for (mirrors KEYCODES in vm/pages.py). */
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

/** An upload's bytes, base64: 25 MB of file at most. */
const MAX_UPLOAD_BASE64 = Math.ceil((25 * 1024 * 1024) / 3) * 4;

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

const pointOf = (act: Record<string, unknown>) => {
  const x = finite(act.x, 0, 10_000);
  const y = finite(act.y, 0, 10_000);
  const id = typeof act.id === "string" ? act.id.slice(0, 40) : "";
  return x === undefined || y === undefined ? undefined : { x, y, id };
};

const pointerActOf = (act: Record<string, unknown>): CastAct | undefined => {
  const at = pointOf(act);
  if (at === undefined) return undefined;
  if (act.a === "tap") {
    const count = finite(act.count, 1, 3);
    return { a: "tap", ...at, ...(count !== undefined ? { count: Math.round(count) } : {}) };
  }
  if (act.a === "move") return { a: "move", ...at, held: act.held === true };
  if (act.a === "down" || act.a === "up" || act.a === "hover") return { a: act.a, ...at };
  return undefined;
};

const pageActOf = (act: Record<string, unknown>): CastAct | undefined => {
  switch (act.a) {
    case "type":
      return typeof act.text === "string" && act.text.length > 0 && act.text.length <= 5_000
        ? { a: "type", text: act.text }
        : undefined;
    case "key":
      return typeof act.key === "string" && (KNOWN_KEYS.has(act.key) || act.key.length === 1)
        ? { a: "key", key: act.key }
        : undefined;
    case "scroll": {
      const dx = finite(act.dx, -20_000, 20_000);
      const dy = finite(act.dy, -20_000, 20_000);
      const at = pointOf(act);
      return dx !== undefined && dy !== undefined ? { a: "scroll", dx, dy, ...at } : undefined;
    }
    case "nav":
      return navOf(act.url);
    case "reload":
    case "back":
      return { a: act.a };
    default:
      return undefined;
  }
};

const controlActOf = (act: Record<string, unknown>): CastAct | undefined => {
  if (act.a === "dialog") {
    const text = typeof act.text === "string" ? act.text.slice(0, 2_000) : undefined;
    return { a: "dialog", accept: act.accept !== false, ...(text !== undefined ? { text } : {}) };
  }
  if (act.a === "upload") {
    const name = typeof act.name === "string" ? act.name.slice(0, 200) : "";
    const data = typeof act.data === "string" ? act.data : "";
    return name !== "" &&
      data !== "" &&
      data.length <= MAX_UPLOAD_BASE64 &&
      /^[A-Za-z0-9+/=]+$/.test(data)
      ? { a: "upload", name, data }
      : undefined;
  }
  if (act.a === "viewport") {
    const w = finite(act.w, 320, 1920);
    const h = finite(act.h, 320, 1600);
    return w !== undefined && h !== undefined
      ? { a: "viewport", w: Math.round(w), h: Math.round(h), mobile: act.mobile === true }
      : undefined;
  }
  return undefined;
};

/** The owner's act, checked and bounded — it is typed into a page, never logged. */
export const castActOf = (body: unknown): CastAct | undefined => {
  if (typeof body !== "object" || body === null) return undefined;
  const act = body as Record<string, unknown>;
  return pointerActOf(act) ?? pageActOf(act) ?? controlActOf(act);
};

/** A viewer's display size (device pixels) from a query or a body. */
export const viewSizeOf = (w: unknown, h: unknown): { w: number; h: number } | undefined => {
  const width = finite(Number(w), 320, 2560);
  const height = finite(Number(h), 240, 1600);
  return width === undefined || height === undefined
    ? undefined
    : { w: Math.round(width), h: Math.round(height) };
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
  options: CastOptions = {},
): Promise<void> => {
  const { res } = args;
  const casts = args.mind.browserCasts;
  if (casts === undefined) {
    args.json(503, { error: "live browser casts are not available on this server" });
    return;
  }
  const session = await casts.for(conversationId, options);
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
    if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  // Backpressure per viewer: while the socket is behind, only the NEWEST
  // frame waits (a slow phone gets fresher frames, never a growing delay).
  let pending: CastFrame | null = null;
  const sendFrame = (frame: CastFrame): void => {
    const { id, data, mime, w, h, url, title, popup } = frame;
    send("frame", { id, data, mime, w, h, url, title, popup });
  };
  res.on("drain", () => {
    if (pending === null) return;
    const frame = pending;
    pending = null;
    sendFrame(frame);
  });
  const off = session.subscribe((event) => {
    if (event.kind === "frame") {
      if (res.writableLength > FRAME_BACKLOG) pending = event.frame;
      else sendFrame(event.frame);
    } else if (event.kind === "ready") send("ready", { drive: session.drive });
    else if (event.kind === "error") send("cast-error", { error: event.error });
    else if (event.kind === "closed") {
      send("closed", { reason: event.reason });
      res.end();
    } else {
      const { kind, ...data } = event;
      send(kind, data);
    }
  });
  const keepalive = setInterval(() => {
    if (!res.destroyed && res.writableLength < FRAME_BACKLOG) res.write(": keepalive\n\n");
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
  options: CastOptions = {},
): Promise<void> => {
  try {
    await streamCast(args, conversationId, stillWanted, options);
  } catch (cause) {
    if (!args.res.headersSent) args.json(503, { error: errorOf(cause) });
    else args.res.end();
  }
};
