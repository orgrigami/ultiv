/**
 * The live signals (docs/LIVE.md) for the terminal: the `/push` socket's
 * coarse `{"kind": …}` frames, so the TUI refetches a slice when it changed
 * instead of polling. Cookie-authenticated on the upgrade; reconnects with
 * the web's backoff; a socket silent for 70 s (the server sends a heartbeat
 * frame every 25 s) is dropped and redialed. Every (re)connect emits `sync`
 * so open views catch up on what they missed.
 */
import WebSocket from "ws";
import { reconnectDelay } from "./backoff.ts";

export type LiveListener = (kind: string) => void;

export interface Live {
  readonly subscribe: (listener: LiveListener) => () => void;
  readonly close: () => void;
}

const SILENCE_MS = 70_000;

export const liveUrlOf = (server: string): string =>
  `${server.replace(/^http:/, "ws:").replace(/^https:/, "wss:")}/push`;

export const connectLive = (server: string, cookie: string): Live => {
  const listeners = new Set<LiveListener>();
  const emit = (kind: string): void => {
    for (const listener of listeners) listener(kind);
  };
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let lastFrame = Date.now();
  let attempt = 0;
  let closed = false;
  const dial = (): void => {
    if (closed) return;
    const ws = new WebSocket(liveUrlOf(server), { headers: { cookie } });
    socket = ws;
    ws.on("open", () => {
      attempt = 0;
      lastFrame = Date.now();
      emit("sync");
    });
    ws.on("message", (data) => {
      lastFrame = Date.now();
      try {
        const frame = JSON.parse(String(data)) as { kind?: unknown };
        if (typeof frame.kind === "string" && frame.kind !== "heartbeat") emit(frame.kind);
      } catch {
        // not a signal
      }
    });
    ws.on("close", () => {
      if (socket === ws) socket = undefined;
      if (closed) return;
      retry = setTimeout(dial, reconnectDelay(attempt++));
    });
    ws.on("error", () => ws.terminate());
  };
  const watchdog = setInterval(() => {
    if (socket !== undefined && Date.now() - lastFrame > SILENCE_MS) socket.terminate();
  }, 15_000);
  watchdog.unref();
  dial();
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {
      closed = true;
      clearInterval(watchdog);
      if (retry !== undefined) clearTimeout(retry);
      socket?.terminate();
    },
  };
};
