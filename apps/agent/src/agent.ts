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
 * reconnects with exponential backoff, reset only after a fresh `ready`; a
 * dial the server refuses outright (close 4001: the token is revoked or was
 * never paired) stops the agent, since no redial could succeed. Nothing here
 * ever logs the token.
 */
import {
  NODE_MAX_FRAME_BYTES,
  type NodeAgentInbound,
  type NodeAgentOutbound,
} from "@spriessen/contracts";
import WebSocket from "ws";
import { createExecs, type Execs } from "./execs.ts";

export { confine } from "./confine.ts";

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
/** The endpoint's close code for a token it does not accept (apps/server/src/agent.ts). */
const REFUSED = 4001;

/** ws(s):// passes through; an http(s):// origin becomes its ws(s) form. */
export const agentUrlOf = (url: string): string =>
  url
    .replace(/\/+$/, "")
    .replace(/^http:/, "ws:")
    .replace(/^https:/, "wss:") + "/agent";

/** What the dial's frames change: the roots, the last sign of life, the backoff. */
interface FrameState {
  roots: readonly string[];
  lastPong: number;
  backoff: number;
}

const applyFrame = (
  frame: NodeAgentOutbound,
  state: FrameState,
  deps: {
    readonly execs: Execs;
    readonly log: (line: string) => void;
    readonly backoffStart: number;
    readonly onReady: AgentOptions["onReady"];
  },
): void => {
  if (frame.type === "ready") {
    state.roots = frame.node.roots;
    state.backoff = deps.backoffStart;
    deps.log(`agent: connected as node ${frame.node.name || frame.node.id}`);
    deps.onReady?.(frame.node);
  } else if (frame.type === "roots") {
    state.roots = frame.roots;
    deps.log(`agent: roots updated (${state.roots.length})`);
  } else if (frame.type === "exec") {
    deps.execs.start(frame, state.roots);
  } else if (frame.type === "cancel") {
    deps.execs.cancel(frame.id);
  } else if (frame.type === "pong") {
    state.lastPong = Date.now();
  }
};

export const connectAgent = (options: AgentOptions): AgentHandle => {
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_DEFAULT_MS;
  const backoffStart = options.backoffMs ?? BACKOFF_DEFAULT_MS;
  const maxBackoff = options.maxBackoffMs ?? MAX_BACKOFF_DEFAULT_MS;
  const log = options.log ?? (() => undefined);
  let socket: WebSocket | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => (resolveDone = resolve));
  const reply = (message: NodeAgentInbound): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const execs = createExecs({ reply, secret: options.token, bashPath: options.bashPath });

  const state: FrameState = { roots: [], lastPong: 0, backoff: backoffStart };
  const handleFrame = (frame: NodeAgentOutbound): void =>
    applyFrame(frame, state, { execs, log, backoffStart, onReady: options.onReady });

  const dial = (): void => {
    if (stopped) return;
    const ws = new WebSocket(agentUrlOf(options.url), {
      headers: { authorization: `Bearer ${options.token}` },
      maxPayload: NODE_MAX_FRAME_BYTES,
    });
    socket = ws;
    ws.on("open", () => {
      state.lastPong = Date.now();
      heartbeat = setInterval(() => {
        if (Date.now() - state.lastPong > heartbeatMs * 2.5) {
          log("agent: no heartbeat answer; redialing");
          ws.terminate(); // the close handler below redials
          return;
        }
        reply({ type: "ping" });
      }, heartbeatMs);
    });
    ws.on("message", (data) => {
      state.lastPong = Date.now(); // any frame proves the link is alive
      let frame: NodeAgentOutbound;
      try {
        frame = JSON.parse(String(data)) as NodeAgentOutbound;
      } catch {
        return; // a malformed frame is dropped, never crashes the agent
      }
      handleFrame(frame);
    });
    ws.on("close", (code) => {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      heartbeat = undefined;
      if (socket === ws) socket = undefined;
      if (code === REFUSED && !stopped) {
        // The token itself was refused (revoked, or never paired): no redial
        // can ever succeed, so stop and say what the owner can do.
        log("agent: the server refused this node's token (revoked or not paired); stopping");
        stop();
      }
      if (stopped) {
        resolveDone();
        return;
      }
      log(`agent: dial closed; retrying in ${state.backoff}ms`);
      retry = setTimeout(dial, state.backoff);
      state.backoff = Math.min(state.backoff * 2, maxBackoff);
    });
    ws.on("error", () => ws.terminate());
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    if (retry !== undefined) clearTimeout(retry);
    execs.killAll();
    if (socket === undefined) resolveDone();
    else socket.terminate();
  };

  // The agent exists to dial OUT: start the first dial right away.
  dial();
  return { stop, done };
};
