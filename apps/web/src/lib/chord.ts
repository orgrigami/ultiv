import {
  createHost,
  webSocketLink,
  type Host,
  type Ref,
  type WebSocketLike,
} from "@earendil-works/chord";
import { Session } from "@spriessen/contracts";

export type SessionRef = Ref<typeof Session>;
export type GuestPrincipal = { kind: "guest" };

let hostPromise: Promise<Host<GuestPrincipal>> | undefined;
let currentSocket: WebSocket | undefined;
const closedListeners = new Set<() => void>();

/**
 * Called when the page's link to the server drops (a server restart, a
 * network change). Open sessions are dead from then on; the listener reopens
 * them. Returns the unsubscribe.
 */
export function onLinkClosed(listener: () => void): () => void {
  closedListeners.add(listener);
  return () => closedListeners.delete(listener);
}

/** Wait before reconnect attempt `attempt` (0-based): 0.5 s doubling, at most 10 s. */
export function reconnectDelay(attempt: number): number {
  return Math.min(500 * 2 ** Math.max(0, attempt), 10_000);
}

function wsUrl(): string {
  const override = import.meta.env.VITE_CHORD_URL;
  if (override !== undefined && override !== "") return override;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  // Same-origin /chord on every facet: the vite dev/preview proxy forwards it,
  // and the server itself accepts upgrades on any path.
  return `${protocol}//${location.host}/chord`;
}

/**
 * The link `socket` is over: forget its host so the next open builds a
 * fresh one, and tell the open sessions. Runs once per socket (a dropped
 * link's late close event finds it already handled), and never clears a
 * NEWER host that a reconnect built meanwhile.
 */
function linkGone(socket: WebSocket, host: Promise<Host<GuestPrincipal>> | undefined): void {
  if (currentSocket !== socket) return;
  currentSocket = undefined;
  if (hostPromise === host) hostPromise = undefined;
  for (const listener of closedListeners) listener();
}

/**
 * Give up on the current link now, without waiting for its close: after a
 * network change or a sleep a socket can stay "open" while nothing will
 * ever arrive on it (the live socket's watchdog notices; see live.ts).
 */
export function dropLink(): void {
  const socket = currentSocket;
  if (socket === undefined) return;
  linkGone(socket, hostPromise);
  try {
    socket.close();
  } catch {
    // Already closing; nothing left to do.
  }
}

/** The browser's chord host: a client peer linked upstream to the server. One per page. */
function clientHost(): Promise<Host<GuestPrincipal>> {
  if (hostPromise !== undefined) return hostPromise;
  const mine: Promise<Host<GuestPrincipal>> = (async () => {
    const host = createHost<GuestPrincipal>({
      name: "web",
      self: { kind: "guest" },
      kind: "client",
    });
    const socket = new WebSocket(wsUrl());
    currentSocket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("chord link failed")), {
        once: true,
      });
    }).catch((error: unknown) => {
      // A failed open must not stay cached, or no retry could ever connect.
      if (hostPromise === mine) hostPromise = undefined;
      if (currentSocket === socket) currentSocket = undefined;
      throw error;
    });
    // A server restart kills this socket; drop the cache so the next open
    // builds a fresh host instead of reusing the dead one, and tell the open
    // sessions so they reconnect instead of showing stale cards and rows.
    socket.addEventListener("close", () => linkGone(socket, mine));
    host.connect(webSocketLink(socket as unknown as WebSocketLike), {
      principal: { kind: "guest" },
    });
    return host;
  })();
  hostPromise = mine;
  return mine;
}

/** Opens (and holds) the session object for `id` on the server. */
export async function openSession(id: string): Promise<SessionRef> {
  const host = await clientHost();
  return host.get(Session, { id });
}
