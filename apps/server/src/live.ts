/**
 * The live event socket: a plain WebSocket at `/push`, cookie-authenticated
 * by the same gate as everything else. Events are COARSE change signals
 * ("tasks changed"), never payloads — the client refetches the slice over
 * the REST it already uses. No replicated objects ride this socket, so the
 * chord attach desync (see AGENTS.md) cannot come back. See docs/LIVE.md.
 */
import { WebSocketServer, type WebSocket } from "ws";

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

class LiveHub {
  private clients = new Set<WebSocket>();

  add(client: WebSocket): void {
    this.clients.add(client);
    client.on("close", () => this.clients.delete(client));
    client.on("error", () => this.clients.delete(client));
  }

  get count(): number {
    return this.clients.size;
  }

  /** One coarse signal to every open client; a dead socket is dropped. */
  emit(kind: LiveKind): void {
    const frame = JSON.stringify({ kind, at: Date.now() });
    for (const client of this.clients) {
      try {
        if (client.readyState === client.OPEN) client.send(frame);
        else this.clients.delete(client);
      } catch {
        this.clients.delete(client);
      }
    }
  }
}

export const liveHub = new LiveHub();
export const liveConnections = (): WebSocketServer => new WebSocketServer({ noServer: true });

/**
 * Trailing-edge coalescing: calls within `ms` of the first collapse into one
 * `fn` at the end of the window. The timer never holds the process open.
 */
export const coalesce = (fn: () => void, ms: number): (() => void) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
    timer.unref?.();
  };
};

/** The one upgrade path the live socket claims (everything else is chord). */
export const LIVE_PATH = "/push";

/** Which slices a REST mutation touches, so screens refetch just those. */
export const liveKindsFor = (method: string, path: string): LiveKind[] => {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return [];
  const prefix = (base: string): boolean => path === base || path.startsWith(`${base}/`);
  if (prefix("/api/tasks") || prefix("/api/needs-you")) return ["tasks", "needs-you"];
  if (prefix("/api/approvals")) return ["approvals", "needs-you"];
  if (prefix("/api/sessions") || prefix("/api/state")) return ["sessions"];
  if (prefix("/api/profiles")) return ["profiles", "sessions"];
  if (prefix("/api/mcp")) return ["connectors"];
  if (prefix("/api/mailbox") || prefix("/api/rooms")) return ["mailbox"];
  if (
    prefix("/api/webhooks") ||
    prefix("/api/cron") ||
    prefix("/api/sensors") ||
    prefix("/api/routines")
  ) {
    return ["routines"];
  }
  if (prefix("/api/vault") || prefix("/api/vault-bindings")) return ["vault"];
  if (prefix("/api/skills")) return ["skills"];
  if (prefix("/api/memory")) return ["memory"];
  return [];
};
