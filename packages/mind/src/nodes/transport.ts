/**
 * The node transport: the server side of the `/agent` dial. The agent (the
 * owner's machine) dials OUT; this registry holds the ONE live connection
 * per paired node (a second dial replaces the first) and turns exec requests
 * into answers. Pending execs are bounded twice: every request carries a
 * timeout (the server waits NODE_EXEC_GRACE_MS past it, so the agent's own
 * kill answers first with the partial output and exit 124), and a closed
 * connection rejects its pending execs at once — a dead agent is a
 * structured error, never a hang. A request's abort signal (the turn
 * stopped: Redirect, a deadline, the harness closing) sends `cancel`, which
 * kills the script's process group on the node. The ext side (the bash
 * tool's node backend) consumes this through a narrow interface, so ext
 * never imports mind.
 */
import { randomUUID } from "node:crypto";
import {
  NODE_EXEC_GRACE_MS,
  type NodeAgentInbound,
  type NodeAgentOutbound,
} from "@spriessen/contracts";

/** What the endpoint registers per live agent dial. */
export interface NodeConn {
  /** Queue one message to this agent (fire and forget; a dead dial rejects the exec, not the send). */
  readonly send: (message: NodeAgentOutbound) => void;
  /** Close the dial (revoke, replaced by a newer dial). */
  readonly close: () => void;
}

export interface NodeExecRequest {
  readonly script: string;
  readonly cwd?: string;
  readonly timeoutMs: number;
  /** Aborted when the asking turn stops; the node kills the script. */
  readonly signal?: AbortSignal;
}

export interface NodeExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface NodeTransport {
  /** The endpoint calls this when a node's agent authenticates and connects. */
  readonly connect: (nodeId: string, conn: NodeConn) => void;
  /** The endpoint calls this when a dial closes (drop, death, replace). */
  readonly disconnect: (nodeId: string, conn: NodeConn) => void;
  /** Force a node's dial closed (revocation kills the connection). */
  readonly drop: (nodeId: string) => void;
  /** True while a live agent dial exists for the node. */
  readonly connected: (nodeId: string) => boolean;
  /** One exec round trip; rejects with a structured, owner-actionable message. */
  readonly exec: (nodeId: string, request: NodeExecRequest) => Promise<NodeExecResult>;
  /** Deliver one agent message (the endpoint parses frames and forwards). */
  readonly receive: (nodeId: string, message: NodeAgentInbound) => void;
  /** Tell a live agent its node's roots changed (no-op while offline). */
  readonly pushRoots: (nodeId: string, roots: readonly string[]) => void;
}

interface Pending {
  readonly resolve: (result: NodeExecResult) => void;
  readonly reject: (cause: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  /** Detaches the abort listener once the exec settles. */
  readonly detach: () => void;
}

const pendingRefusal = (why: string): Error => new Error(`node exec refused: ${why}`);

export const createNodeTransport = (): NodeTransport => {
  const conns = new Map<string, NodeConn>();
  const pending = new Map<string, { nodeId: string } & Pending>();

  const rejectPending = (nodeId: string, why: string): void => {
    for (const [id, entry] of pending) {
      if (entry.nodeId !== nodeId) continue;
      clearTimeout(entry.timer);
      entry.detach();
      pending.delete(id);
      entry.reject(pendingRefusal(why));
    }
  };

  return {
    connect: (nodeId, conn) => {
      const existing = conns.get(nodeId);
      if (existing !== undefined && existing !== conn) existing.close(); // one dial per node
      conns.set(nodeId, conn);
    },
    disconnect: (nodeId, conn) => {
      if (conns.get(nodeId) !== conn) return; // a stale dial closing late
      conns.delete(nodeId);
      rejectPending(nodeId, "the node agent disconnected");
    },
    drop: (nodeId) => {
      const conn = conns.get(nodeId);
      if (conn === undefined) return;
      conns.delete(nodeId);
      conn.close();
      rejectPending(nodeId, "the node was revoked");
    },
    connected: (nodeId) => conns.has(nodeId),
    exec: (nodeId, request) =>
      new Promise<NodeExecResult>((resolve, reject) => {
        const conn = conns.get(nodeId);
        if (conn === undefined) {
          reject(
            pendingRefusal("the node is not connected (its agent is not dialing in right now)"),
          );
          return;
        }
        if (request.signal?.aborted === true) {
          reject(pendingRefusal("the turn was stopped before the script started"));
          return;
        }
        const id = randomUUID();
        const onAbort = (): void => {
          const entry = pending.get(id);
          if (entry === undefined) return;
          clearTimeout(entry.timer);
          pending.delete(id);
          conns.get(nodeId)?.send({ type: "cancel", id });
          reject(pendingRefusal("the turn was stopped; the script was killed on the node"));
        };
        const detach = (): void => request.signal?.removeEventListener("abort", onAbort);
        const timer = setTimeout(() => {
          pending.delete(id);
          detach();
          conns.get(nodeId)?.send({ type: "cancel", id });
          reject(pendingRefusal(`the node agent did not answer within ${request.timeoutMs} ms`));
        }, request.timeoutMs + NODE_EXEC_GRACE_MS);
        pending.set(id, { nodeId, resolve, reject, timer, detach });
        request.signal?.addEventListener("abort", onAbort, { once: true });
        conn.send({
          type: "exec",
          id,
          script: request.script,
          ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
          timeoutMs: request.timeoutMs,
        });
      }),
    receive: (nodeId, message) => {
      if (message.type === "ping") {
        conns.get(nodeId)?.send({ type: "pong" });
        return;
      }
      const entry = pending.get(message.id);
      if (entry === undefined || entry.nodeId !== nodeId) return;
      clearTimeout(entry.timer);
      entry.detach();
      pending.delete(message.id);
      if (message.type === "result") {
        entry.resolve({
          stdout: message.stdout,
          stderr: message.stderr,
          exitCode: message.exitCode,
        });
      } else {
        entry.reject(new Error(`node exec failed: ${message.message}`));
      }
    },
    pushRoots: (nodeId, roots) => conns.get(nodeId)?.send({ type: "roots", roots: [...roots] }),
  };
};
