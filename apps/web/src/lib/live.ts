/**
 * The live event socket: one WebSocket to `/push` carrying coarse change
 * signals ("tasks changed"), never payloads. Screens subscribe by slice and
 * refetch over the REST they already use; a reconnect raises `sync` so every
 * open screen catches up. No polling anywhere.
 */
import { UNAUTHORIZED_EVENT } from "./auth.ts";
import { reconnectDelay } from "./chord.ts";

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
  | "memory";

type Handler = (kind: LiveKind) => void;

const handlers = new Set<Handler>();
let socket: WebSocket | null = null;
let attempt = 0;
let closed = false;

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
    // Everything refetches once after a (re)connect.
    dispatch("sync");
  };
  socket.onmessage = (event) => {
    try {
      const frame = JSON.parse(event.data as string) as { kind?: string };
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

/** Subscribe to change signals; the socket opens with the first subscriber
 * and lives for the page (screens come and go; the signals are cheap). */
export const onLive = (handler: Handler): (() => void) => {
  handlers.add(handler);
  connect();
  return () => {
    handlers.delete(handler);
  };
};
