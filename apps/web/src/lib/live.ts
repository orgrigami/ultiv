/**
 * The live event socket: one WebSocket to `/push` carrying coarse change
 * signals ("tasks changed"), never payloads. Screens subscribe by slice and
 * refetch over the REST they already use; a reconnect raises `sync` so every
 * open screen catches up. No polling anywhere.
 */
import { UNAUTHORIZED_EVENT } from "./auth.ts";
import { dropLink, reconnectDelay } from "./chord.ts";

/** The close code the server uses when the socket's session has ended. */
export const SIGNED_OUT_CLOSE = 4401;

export type LiveKind =
  | "sync"
  | "tasks"
  | "approvals"
  | "needs-you"
  | "sessions"
  | "profiles"
  | "connectors"
  | "mailbox"
  | "routines"
  | "vault"
  | "skills"
  | "memory"
  | "evals";

type Handler = (kind: LiveKind) => void;

const handlers = new Set<Handler>();
let socket: WebSocket | null = null;
let attempt = 0;
let closed = false;
/** When the open socket last said anything (a signal or the server's heartbeat). */
let lastFrameAt = 0;

/**
 * The server sends a heartbeat frame every 25 s (apps/server/src/heartbeat.ts).
 * Silence past this means the socket is half-open: a phone slept or the
 * network changed, no close will ever arrive, and nothing will update.
 */
export const SILENT_AFTER_MS = 70_000;

/** Whether an open socket has been silent too long to trust (pure, for tests). */
export const isStale = (now: number, lastFrame: number): boolean =>
  now - lastFrame > SILENT_AFTER_MS;

const dispatch = (kind: LiveKind): void => {
  for (const handler of handlers) handler(kind);
};

function wsUrl(): string {
  const override = import.meta.env.VITE_CHORD_URL;
  const base =
    override !== undefined && override !== ""
      ? override.replace(/^ws(s?):/, "ws$1:").replace(/\/$/, "")
      : `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
  return `${base}/push`;
}

const connect = (): void => {
  if (closed || socket !== null) return;
  socket = new WebSocket(wsUrl());
  socket.onopen = () => {
    attempt = 0;
    lastFrameAt = Date.now();
    // Everything refetches once after a (re)connect.
    dispatch("sync");
  };
  socket.onmessage = (event) => {
    lastFrameAt = Date.now();
    try {
      const frame = JSON.parse(event.data as string) as { kind?: string };
      if (frame.kind === "heartbeat") return;
      if (frame.kind !== undefined) dispatch(frame.kind as LiveKind);
    } catch {
      // A malformed frame is dropped; REST stays the source of truth.
    }
  };
  socket.onclose = (event) => {
    socket = null;
    // Signed out elsewhere (or expired): bring the sign-in gate back now,
    // rather than leaving a screen that quietly stops updating.
    if (event.code === SIGNED_OUT_CLOSE) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    if (closed) return;
    const delay = reconnectDelay(attempt);
    attempt += 1;
    setTimeout(connect, delay);
  };
  socket.onerror = () => socket?.close();
};

/**
 * Abandon both sockets and reconnect now: the live socket here, and the
 * chord link the chat rides (it went quiet over the same dead path, and a
 * socket that never closes never reconnects by itself).
 */
const reconnectNow = (): void => {
  const dead = socket;
  if (dead !== null) {
    dead.onopen = null;
    dead.onmessage = null;
    dead.onclose = null;
    dead.onerror = null;
    try {
      dead.close();
    } catch {
      // Already closing.
    }
    socket = null;
  }
  dropLink();
  attempt = 0;
  connect();
};

/** Reconnect when the open socket has gone silent past the heartbeat. */
const checkStale = (): void => {
  if (socket?.readyState === WebSocket.OPEN && isStale(Date.now(), lastFrameAt)) reconnectNow();
};

let watching = false;
/**
 * The watchdog: a timer while the page lives, plus the moments a dead
 * socket is most likely — the page coming back into view (a phone
 * waking; iOS PWAs do not reliably fire focus) and the network coming back.
 * Not a data poll: it only checks how long the socket has been quiet.
 */
const watch = (): void => {
  if (watching) return;
  watching = true;
  setInterval(checkStale, 15_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkStale();
  });
  window.addEventListener("online", reconnectNow);
};

/** Subscribe to change signals; the socket opens with the first subscriber
 * and lives for the page (screens come and go; the signals are cheap). */
export const onLive = (handler: Handler): (() => void) => {
  handlers.add(handler);
  watch();
  connect();
  return () => {
    handlers.delete(handler);
  };
};
