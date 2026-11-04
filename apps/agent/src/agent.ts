/**
 * The node agent's dial: a long-lived OUTBOUND WebSocket to the server's
 * `/agent` endpoint, authenticated with the node's pairing token in the
 * upgrade's `Authorization: Bearer` header (never the URL, which proxies
 * log). It never listens — the server never dials in. After the server's
 * `ready` frame the agent knows its node's identity and registered roots
 * (a `roots` frame replaces them live) and answers `exec` frames through
 * `runScript`: the START directory must lie inside a root (`resolveInside`,
 * @spriessen/core) or the exec is refused locally; a `cancel` frame kills
 * the script's process group. Heartbeats ride the protocol's JSON ping/pong
 * and a watchdog: no pong for 2.5 beats means the link is dead (a laptop
 * that slept, a NAT that dropped it) and the agent redials. A dropped dial
 * reconnects with exponential backoff, reset only after a fresh `ready`, so
 * an auth refusal backs off instead of hammering. Nothing here ever logs
 * the token.
 */
import { resolveInside } from "@spriessen/core";
import {
  NODE_MAX_FRAME_BYTES,
  type NodeAgentInbound,
  type NodeAgentOutbound,
} from "@spriessen/contracts";
import WebSocket from "ws";
import { runScript, type RunningScript } from "./run-script.ts";

export interface AgentOptions {
  /** The server origin, e.g. `http://127.0.0.1:8787` (ws(s):// also accepted). */
  readonly url: string;
  /** The pairing token minted when the owner paired this node. */
  readonly token: string;
  /** Heartbeat interval; default 15 000 ms. */
  readonly heartbeatMs?: number;
  /** First reconnect delay; default 1 000 ms. Doubles up to maxBackoffMs. */
  readonly backoffMs?: number;
  /** Reconnect delay ceiling; default 30 000 ms. */
  readonly maxBackoffMs?: number;
  /** Shell to run; default `/bin/bash` (tests may point it elsewhere). */
  readonly bashPath?: string;
  /** Progress lines (connection, retries, exec refusals); never a token. */
  readonly log?: (line: string) => void;
  /** Called on every `ready` (the CLI shows which node it is). */
  readonly onReady?: (node: { id: string; name: string; roots: readonly string[] }) => void;
}

export interface AgentHandle {
  /** Stop dialing, close any live socket, kill every running script's group. */
  readonly stop: () => void;
  /** Resolves once the agent is fully stopped. */
  readonly done: Promise<void>;
}

const HEARTBEAT_DEFAULT_MS = 15_000;
const BACKOFF_DEFAULT_MS = 1_000;
const MAX_BACKOFF_DEFAULT_MS = 30_000;

/** ws(s):// passes through; an http(s):// origin becomes its ws(s) form. */
export const agentUrlOf = (url: string): string =>
  url
    .replace(/\/+$/, "")
    .replace(/^http:/, "ws:")
    .replace(/^https:/, "wss:") + "/agent";

/** The start directory: inside one registered root, or refused. */
export const confine = (roots: readonly string[], cwd: string | undefined): string => {
  const want = cwd ?? roots[0];
  if (want === undefined) throw new Error("the agent has no registered roots");
  for (const root of roots) {
    try {
      return resolveInside(root, want);
    } catch {
      // try the next root
    }
  }
  throw new Error(
    `cwd "${want.slice(0, 200)}" is outside this node's registered roots ` +
      `(${roots.map((root) => root.slice(0, 120)).join(", ")})`,
  );
};

export const connectAgent = (options: AgentOptions): AgentHandle => {
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_DEFAULT_MS;
  const backoffStart = options.backoffMs ?? BACKOFF_DEFAULT_MS;
  const maxBackoff = options.maxBackoffMs ?? MAX_BACKOFF_DEFAULT_MS;
  const log = options.log ?? (() => undefined);
  let roots: readonly string[] = [];
  let backoff = backoffStart;
  let socket: WebSocket | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let lastPong = 0;
  let stopped = false;
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => (resolveDone = resolve));
  const running = new Map<string, RunningScript>();
  const reply = (message: NodeAgentInbound): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  const handleExec = (frame: Extract<NodeAgentOutbound, { type: "exec" }>): void => {
    let cwd: string;
    try {
      cwd = confine(roots, frame.cwd);
    } catch (cause) {
      reply({ type: "error", id: frame.id, message: String(cause) });
      return;
    }
    const script = runScript({
      script: frame.script,
      cwd,
      timeoutMs: frame.timeoutMs,
      secret: options.token,
      ...(options.bashPath !== undefined ? { bashPath: options.bashPath } : {}),
    });
    running.set(frame.id, script);
    script.result.then(
      (result) => {
        if (running.delete(frame.id)) reply({ type: "result", id: frame.id, ...result });
      },
      (cause: unknown) => {
        if (running.delete(frame.id))
          reply({
            type: "error",
            id: frame.id,
            message: `the agent could not run the script: ${String(cause)}`,
          });
      },
    );
  };

  const handleFrame = (frame: NodeAgentOutbound): void => {
    if (frame.type === "ready") {
      roots = frame.node.roots;
      backoff = backoffStart;
      log(`agent: connected as node ${frame.node.name || frame.node.id}`);
      options.onReady?.(frame.node);
    } else if (frame.type === "roots") {
      roots = frame.roots;
      log(`agent: roots updated (${roots.length})`);
    } else if (frame.type === "exec") {
      handleExec(frame);
    } else if (frame.type === "cancel") {
      const script = running.get(frame.id);
      running.delete(frame.id); // a cancelled exec sends nothing back
      script?.kill();
    } else if (frame.type === "pong") {
      lastPong = Date.now();
    }
  };

  const dial = (): void => {
    if (stopped) return;
    const ws = new WebSocket(agentUrlOf(options.url), {
      headers: { authorization: `Bearer ${options.token}` },
      maxPayload: NODE_MAX_FRAME_BYTES,
    });
    socket = ws;
    ws.on("open", () => {
      lastPong = Date.now();
      heartbeat = setInterval(() => {
        if (Date.now() - lastPong > heartbeatMs * 2.5) {
          log("agent: no heartbeat answer; redialing");
          ws.terminate(); // the close handler below redials
          return;
        }
        reply({ type: "ping" });
      }, heartbeatMs);
    });
    ws.on("message", (data) => {
      lastPong = Date.now(); // any frame proves the link is alive
      let frame: NodeAgentOutbound;
      try {
        frame = JSON.parse(String(data)) as NodeAgentOutbound;
      } catch {
        return; // a malformed frame is dropped, never crashes the agent
      }
      handleFrame(frame);
    });
    ws.on("close", () => {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      heartbeat = undefined;
      if (socket === ws) socket = undefined;
      if (stopped) {
        resolveDone();
        return;
      }
      log(`agent: dial closed; retrying in ${backoff}ms`);
      retry = setTimeout(dial, backoff);
      backoff = Math.min(backoff * 2, maxBackoff);
    });
    ws.on("error", () => ws.terminate());
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    if (retry !== undefined) clearTimeout(retry);
    for (const script of running.values()) script.kill();
    running.clear();
    if (socket === undefined) resolveDone();
    else socket.terminate();
  };

  // The agent exists to dial OUT: start the first dial right away.
  dial();
  return { stop, done };
};
