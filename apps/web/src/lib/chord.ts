import {
  createHost,
  webSocketLink,
  type Host,
  type Ref,
  type WebSocketLike,
} from "@earendil-works/chord";
import { Session } from "@ultiv/contracts";

export type SessionRef = Ref<typeof Session>;
export type GuestPrincipal = { kind: "guest" };

let hostPromise: Promise<Host<GuestPrincipal>> | undefined;

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
    });
    // A server restart kills this socket; drop the cache so the next
    // navigation builds a fresh host instead of reusing the dead one.
    socket.addEventListener("close", () => {
      if (hostPromise !== undefined) hostPromise = undefined;
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
