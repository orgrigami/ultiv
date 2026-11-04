/**
 * The `/agent` WebSocket endpoint: the node agent's dial-in. The agent
 * authenticates with its pairing token in the upgrade's `Authorization:
 * Bearer` header (hash-compared against the registry — a token never appears
 * in a log or a read; the old `?token=` query is still read so an agent from
 * before the header keeps working, but proxies log URLs, so current agents
 * never send it). ONE dial per node (a second replaces the first). The
 * socket's handlers attach BEFORE the async token check, so a dial that dies
 * mid-check is never registered as live. Heartbeats ride the protocol's
 * ping/pong (and the server's ws-level heartbeat in main.ts); a ping bumps
 * the node's `lastSeenAt` at most once a minute. Exec traffic is forwarded to
 * the mind's transport. The agent's start-directory check is the AGENT's
 * own; the server never trusts a cwd the agent would refuse — an exec error
 * frame comes back verbatim.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import {
  NODE_MAX_FRAME_BYTES,
  type NodeAgentInbound,
  type NodeAgentOutbound,
} from "@spriessen/contracts";
import {
  markNodeDisconnected,
  markNodeSeen,
  nodeIdForToken,
  nodeOf,
  type ConverseService,
  type NodeTransport,
} from "@spriessen/mind";

export const AGENT_PATH = "/agent";

/** How often a live dial's pings refresh the stored `lastSeenAt`. */
const SEEN_EVERY_MS = 60_000;

export interface AgentEndpoint {
  readonly wss: WebSocketServer;
  /** Route one upgrade whose path is AGENT_PATH (main.ts calls this first). */
  readonly handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  /** Revoke kills the live dial (the REST route calls this). */
  readonly drop: (nodeId: string) => void;
  /** The owner changed a node's roots: the live agent hears it at once. */
  readonly pushRoots: (nodeId: string, roots: readonly string[]) => void;
  /** True while the node's agent is dialed in (the truth `connected` reads). */
  readonly connected: (nodeId: string) => boolean;
  /** Close every live dial (server shutdown must not wait on agents). */
  readonly stop: () => void;
}

/** The pairing token from the upgrade: the Bearer header, else the legacy query. */
export const agentTokenOf = (req: IncomingMessage): string => {
  const header = req.headers.authorization ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
  if (bearer !== undefined && bearer !== "") return bearer;
  return new URL(req.url ?? "/", "http://localhost").searchParams.get("token") ?? "";
};

export const agentEndpoint = (deps: {
  readonly converse: ConverseService;
  readonly transport: NodeTransport;
}): AgentEndpoint => {
  const wss = new WebSocketServer({ noServer: true, maxPayload: NODE_MAX_FRAME_BYTES });
  const live = new Map<string, WebSocket>();

  const accept = async (client: WebSocket, req: IncomingMessage): Promise<void> => {
    // Handlers first: a close during the token check below must be seen.
    let nodeId: string | undefined;
    let closed = false;
    let seenAt = Date.now();
    const conn = {
      send: (message: NodeAgentOutbound) => {
        if (client.readyState === client.OPEN) client.send(JSON.stringify(message));
      },
      close: () => {
        if (client.readyState === client.OPEN) client.close(4003, "dropped");
      },
    };
    client.on("message", (data) => {
      if (nodeId === undefined) return; // nothing is answered before `ready`
      let message: NodeAgentInbound;
      try {
        message = JSON.parse(String(data)) as NodeAgentInbound;
      } catch {
        return; // a malformed frame is dropped, never crashes the endpoint
      }
      if (message.type === "ping" && Date.now() - seenAt > SEEN_EVERY_MS) {
        seenAt = Date.now();
        void markNodeSeen(deps.converse, nodeId).catch(() => undefined);
      }
      deps.transport.receive(nodeId, message);
    });
    client.on("close", () => {
      closed = true;
      if (nodeId === undefined) return;
      if (live.get(nodeId) === client) live.delete(nodeId);
      deps.transport.disconnect(nodeId, conn);
      void markNodeDisconnected(deps.converse, nodeId).catch(() => undefined);
    });
    const id = await nodeIdForToken(deps.converse, agentTokenOf(req));
    if (id === undefined) {
      // Fail closed: a bad or revoked token never opens the channel.
      client.close(4001, "unauthorized");
      return;
    }
    const node = await nodeOf(deps.converse, id);
    if (closed || node === undefined) return;
    const previous = live.get(id);
    if (previous !== undefined && previous !== client) previous.close(4002, "replaced");
    live.set(id, client);
    nodeId = id;
    // The ONE conn object registered for this dial: the same object goes
    // back to disconnect on close, so the transport can tell a real dial's
    // end from a stale dial closing late (and reject its pending execs).
    deps.transport.connect(id, conn);
    conn.send({ type: "ready", node: { id, name: node.name, roots: node.roots } });
    await markNodeSeen(deps.converse, id);
  };

  wss.on("connection", (client: WebSocket, req: IncomingMessage) => {
    accept(client, req).catch(() => client.close(1011, "internal"));
  });

  return {
    wss,
    handleUpgrade: (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (client) => wss.emit("connection", client, req));
    },
    drop: (nodeId) => {
      const client = live.get(nodeId);
      if (client !== undefined) client.close(4003, "revoked");
      deps.transport.drop(nodeId);
    },
    pushRoots: (nodeId, roots) => deps.transport.pushRoots(nodeId, roots),
    connected: (nodeId) => deps.transport.connected(nodeId),
    stop: () => {
      for (const client of wss.clients) client.terminate();
      live.clear();
      wss.close();
    },
  };
};
