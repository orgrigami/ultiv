/**
 * The node agent's dial: a long-lived OUTBOUND WebSocket to the server's
 * `/agent` endpoint, authenticated with the node's pairing token on the
 * upgrade. It never listens — the server never dials in. After the server's
 * `ready` frame the agent knows its node's identity and registered roots and
 * answers `exec` frames: each one spawns `/bin/bash -c`, confined by
 * `resolveInside` (@spriessen/core) to the roots — a cwd outside them is
 * refused locally and reported back as an error frame. Output is capped at
 * NODE_OUTPUT_CAP per stream (the bash tool's cap); the server-side timeout
 * is honored with a SIGKILL and exit code 124. Heartbeats ride the
 * protocol's JSON ping/pong; a dropped dial reconnects with exponential
 * backoff (reset only after a fresh `ready`, so an auth refusal backs off
 * instead of hammering). Nothing here ever logs the token.
 */
import { spawn } from "node:child_process";
import { resolveInside } from "@spriessen/core";
import {
  NODE_OUTPUT_CAP,
  type NodeAgentInbound,
  type NodeAgentOutbound,
} from "@spriessen/contracts";
import WebSocket from "ws";

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
}

export interface AgentHandle {
  /** Stop dialing, close any live socket, kill any running exec's child. */
  readonly stop: () => void;
  /** Resolves once the agent is fully stopped. */
  readonly done: Promise<void>;
}

/** The agent's live state across reconnects. */
interface AgentState {
  roots: readonly string[];
  nodeName: string;
  backoff: number;
}

const HEARTBEAT_DEFAULT_MS = 15_000;
const BACKOFF_DEFAULT_MS = 1_000;
const MAX_BACKOFF_DEFAULT_MS = 30_000;

export const connectAgent = (options: AgentOptions): AgentHandle => {
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_DEFAULT_MS;
  const backoffStart = options.backoffMs ?? BACKOFF_DEFAULT_MS;
  const maxBackoff = options.maxBackoffMs ?? MAX_BACKOFF_DEFAULT_MS;
  const log = options.log ?? (() => undefined);
  const state: AgentState = { roots: [], nodeName: "", backoff: backoffStart };
  let socket: WebSocket | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const children = new Set<ReturnType<typeof spawn>>();
  const reply = (message: NodeAgentInbound): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  /** ws(s):// passes through; an http(s):// origin becomes its ws(s) form. */
  const wsUrlOf = (): string =>
    options.url.replace(/^http:/, "ws:").replace(/^https:/, "wss:") + "/agent";

  /** The cwd check IS the agent's own: inside one registered root, or refused. */
  const confine = (cwd: string | undefined): string => {
    if (state.roots.length === 0) throw new Error("the agent has no registered roots");
    const want = cwd ?? state.roots[0];
    if (want === undefined) throw new Error("the agent has no registered roots");
    for (const root of state.roots) {
      try {
        return resolveInside(root, want);
      } catch {
        // try the next root
      }
    }
    throw new Error(
      `cwd "${want.slice(0, 200)}" is outside this node's registered roots ` +
        `(${state.roots.map((root) => root.slice(0, 120)).join(", ")})`,
    );
  };

  const handleExec = (frame: Extract<NodeAgentOutbound, { type: "exec" }>): void => {
    let cwd: string;
    try {
      cwd = confine(frame.cwd);
    } catch (cause) {
      reply({ type: "error", id: frame.id, message: String(cause) });
      return;
    }
    const child = spawn(options.bashPath ?? "/bin/bash", ["-c", frame.script], {
      cwd,
      timeout: frame.timeoutMs,
      killSignal: "SIGKILL",
    });
    children.add(child);
    child.on("close", () => children.delete(child));
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < NODE_OUTPUT_CAP) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < NODE_OUTPUT_CAP) stderr += chunk.toString("utf8");
    });
    child.on("error", (cause) => {
      reply({
        type: "error",
        id: frame.id,
        message: `the agent could not run the script: ${String(cause)}`,
      });
    });
    child.on("close", (code, signal) => {
      children.delete(child);
      if (signal !== null) stderr += `\n[bash] killed by ${signal} after ${frame.timeoutMs}ms`;
      reply({
        type: "result",
        id: frame.id,
        stdout: stdout.slice(0, NODE_OUTPUT_CAP),
        stderr: stderr.slice(0, NODE_OUTPUT_CAP),
        exitCode: signal !== null ? 124 : (code ?? 1),
      });
    });
  };

  const clearTimers = (): void => {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    if (retry !== undefined) clearTimeout(retry);
    heartbeat = undefined;
    retry = undefined;
  };

  const dial = (): void => {
    if (stopped) return;
    const ws = new WebSocket(`${wsUrlOf()}?token=${encodeURIComponent(options.token)}`);
    socket = ws;
    ws.on("open", () => {
      // Backoff resets only when the server CONFIRMS the dial (ready below):
      // an auth refusal keeps backing off instead of hammering.
      heartbeat = setInterval(() => reply({ type: "ping" }), heartbeatMs);
    });
    ws.on("message", (data) => {
      let frame: NodeAgentOutbound;
      try {
        frame = JSON.parse(String(data)) as NodeAgentOutbound;
      } catch {
        return; // a malformed frame is dropped, never crashes the agent
      }
      if (frame.type === "ready") {
        state.roots = frame.node.roots;
        state.nodeName = frame.node.name;
        state.backoff = backoffStart;
        log(`agent: connected as node ${frame.node.name || frame.node.id}`);
      } else if (frame.type === "exec") {
        handleExec(frame);
      }
      // pong: the heartbeat answer — nothing to do; the socket being open is the signal.
    });
    ws.on("close", () => {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      heartbeat = undefined;
      if (socket === ws) socket = undefined;
      if (stopped) return;
      log(`agent: dial closed; retrying in ${state.backoff}ms`);
      retry = setTimeout(dial, state.backoff);
      state.backoff = Math.min(state.backoff * 2, maxBackoff);
    });
    ws.on("error", () => ws.terminate());
  };

  const stop = (): void => {
    stopped = true;
    clearTimers();
    socket?.close(1000, "stopped");
    socket?.terminate();
    for (const child of children) child.kill("SIGKILL");
  };

  // The agent exists to dial OUT: start the first dial right away.
  dial();

  return {
    stop,
    done: new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (stopped && socket === undefined && children.size === 0) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    }),
  };
};
