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

/** The browser's chord host: a client peer linked upstream to the server. One per page. */
function clientHost(): Promise<Host<GuestPrincipal>> {
  hostPromise ??= (async () => {
    const host = createHost<GuestPrincipal>({
      name: "web",
      self: { kind: "guest" },
      kind: "client",
    });
    const socket = new WebSocket(wsUrl());
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("chord link failed")), {
        once: true,
      });
    }).catch((error: unknown) => {
      // A failed open must not stay cached, or no retry could ever connect.
      hostPromise = undefined;
      throw error;
    });
    // A server restart kills this socket; drop the cache so the next open
    // builds a fresh host instead of reusing the dead one, and tell the open
    // sessions so they reconnect instead of showing stale cards and rows.
    socket.addEventListener("close", () => {
      hostPromise = undefined;
      for (const listener of closedListeners) listener();
    });
    host.connect(webSocketLink(socket as unknown as WebSocketLike), {
      principal: { kind: "guest" },
    });
    return host;
  })();
  return hostPromise;
}

/** Opens (and holds) the session object for `id` on the server. */
export async function openSession(id: string): Promise<SessionRef> {
  const host = await clientHost();
  return host.get(Session, { id });
}
