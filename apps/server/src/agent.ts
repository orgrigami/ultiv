/**
 * The `/agent` WebSocket endpoint: the node agent's dial-in. The agent
 * authenticates with its pairing token in the upgrade query (hash-compared
 * against the registry — a token never appears in a log or a read), ONE dial
 * per node (a second replaces the first), heartbeats ride the protocol's
 * ping/pong, and exec traffic is forwarded to the mind's transport. The
 * agent's cwd confinement is the AGENT's own check; the server never trusts
 * a cwd the agent would refuse — an exec error frame comes back verbatim.
 */
import { WebSocketServer, type WebSocket } from "ws";
import type { NodeAgentInbound, NodeAgentOutbound } from "@spriessen/contracts";
import {
  markNodeDisconnected,
  markNodeSeen,
  nodeIdForToken,
  nodeOf,
  type ConverseService,
  type NodeTransport,
} from "@spriessen/mind";

export const AGENT_PATH = "/agent";

export interface AgentEndpoint {
  readonly wss: WebSocketServer;
  /** Route one upgrade whose path is AGENT_PATH (main.ts calls this first). */
  readonly handleUpgrade: (
    req: import("node:http").IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ) => void;
  /** Revoke kills the live dial (the REST route calls this). */
  readonly drop: (nodeId: string) => void;
  readonly stop: () => void;
}

export const agentEndpoint = (deps: {
  readonly converse: ConverseService;
  readonly transport: NodeTransport;
}): AgentEndpoint => {
  const wss = new WebSocketServer({ noServer: true });
  const live = new Map<string, WebSocket>();

  wss.on("connection", (client: WebSocket, req: import("node:http").IncomingMessage) => {
    void (async () => {
      const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token") ?? "";
      const nodeId = await nodeIdForToken(deps.converse, token);
      if (nodeId === undefined) {
        // Fail closed: a bad or revoked token never opens the channel.
        client.close(4001, "unauthorized");
        return;
      }
      const node = await nodeOf(deps.converse, nodeId);
      const previous = live.get(nodeId);
      if (previous !== undefined && previous !== client) previous.close(4002, "replaced");
      live.set(nodeId, client);
      // The ONE conn object registered for this dial: the same object goes
      // back to disconnect on close, so the transport can tell a real dial's
      // end from a stale dial closing late (and reject its pending execs).
      const conn = {
        send: (message: NodeAgentOutbound) =>
          client.readyState === client.OPEN && client.send(JSON.stringify(message)),
        close: () => client.readyState === client.OPEN && client.close(4003, "dropped"),
      };
      deps.transport.connect(nodeId, conn);
      await markNodeSeen(deps.converse, nodeId);
      if (client.readyState === client.OPEN) {
        const ready: NodeAgentOutbound = {
          type: "ready",
          node: {
            id: nodeId,
            name: node?.name ?? "",
            roots: node?.roots ?? [],
          },
        };
        client.send(JSON.stringify(ready));
      }
      client.on("message", (data) => {
        let message: NodeAgentInbound;
        try {
          message = JSON.parse(String(data)) as NodeAgentInbound;
        } catch {
          return; // a malformed frame is dropped, never crashes the endpoint
        }
        deps.transport.receive(nodeId, message);
      });
      client.on("close", () => {
        if (live.get(nodeId) === client) live.delete(nodeId);
        deps.transport.disconnect(nodeId, conn);
        void markNodeDisconnected(deps.converse, nodeId).catch(() => {});
      });
    })().catch(() => client.close(1011, "internal"));
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
    stop: () => wss.close(),
  };
};
