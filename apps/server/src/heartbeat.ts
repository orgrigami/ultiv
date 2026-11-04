/**
 * Socket heartbeats. A phone that sleeps or switches networks leaves its
 * sockets half-open: no close ever arrives, the server keeps writing into
 * nothing, and the page sits on a socket that will never speak again.
 *
 * Server side, every open socket (chord links and /push) is pinged each
 * beat; one that has not answered the previous ping is terminated, which
 * frees its links. Browsers answer pings on their own but never show them
 * to the page, so /push also carries a tiny `heartbeat` frame each beat:
 * the client's watchdog (apps/web/src/lib/live.ts) reconnects when frames
 * stop arriving.
 */
import type { WebSocket, WebSocketServer } from "ws";

export const HEARTBEAT_MS = 25_000;

const alive = new WeakMap<WebSocket, boolean>();

/** Track one socket's pongs (call on every accepted connection). */
export const watchPongs = (client: WebSocket): void => {
  alive.set(client, true);
  client.on("pong", () => alive.set(client, true));
};

/** One beat over a server's clients: terminate the silent, ping the rest. */
export const beat = (server: WebSocketServer): number => {
  let dropped = 0;
  for (const client of server.clients) {
    if (alive.get(client) === false) {
      client.terminate();
      dropped += 1;
      continue;
    }
    alive.set(client, false);
    try {
      client.ping();
    } catch {
      client.terminate();
      dropped += 1;
    }
  }
  return dropped;
};

/** Beat every `everyMs`; `onBeat` runs after each (the /push frame). Returns the stop. */
export const startHeartbeat = (
  servers: readonly WebSocketServer[],
  onBeat: () => void,
  everyMs = HEARTBEAT_MS,
): (() => void) => {
  for (const server of servers) server.on("connection", watchPongs);
  const timer = setInterval(() => {
    for (const server of servers) beat(server);
    onBeat();
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
};
