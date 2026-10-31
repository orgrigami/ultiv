/**
 * Open sockets outlive the handshake that checked them, so each one is
 * remembered with the session it opened under, and a sweep closes any whose
 * session is gone: signed out, expired, ended by a passcode change, or wiped
 * by the recovery command. The close code 4401 tells the client to stop
 * and re-check sign-in (a reconnect without a session is refused anyway).
 */
import type { AuthStore } from "./store.ts";

export const SIGNED_OUT_CLOSE = 4401;
export const SOCKET_SWEEP_MS = 5_000;

export interface ClosableSocket {
  close(code: number, reason: string): void;
  once(event: "close", listener: () => void): unknown;
}

export interface SocketSessions {
  track(socket: ClosableSocket, sessionId: string): void;
  /** Close every socket whose session is no longer live; returns how many. */
  sweep(): number;
  stop(): void;
}

export const socketSessions = (store: AuthStore, everyMs = SOCKET_SWEEP_MS): SocketSessions => {
  const open = new Map<ClosableSocket, string>();
  const sweep = (): number => {
    let closed = 0;
    for (const [socket, sessionId] of open) {
      if (store.sessionLive(sessionId)) continue;
      open.delete(socket);
      socket.close(SIGNED_OUT_CLOSE, "signed out");
      closed += 1;
    }
    return closed;
  };
  const timer = setInterval(sweep, everyMs);
  timer.unref();
  return {
    track: (socket, sessionId) => {
      open.set(socket, sessionId);
      socket.once("close", () => open.delete(socket));
    },
    sweep,
    stop: () => clearInterval(timer),
  };
};
