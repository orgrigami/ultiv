/**
 * One live MCP server connection: connect (with the Streamable HTTP → SSE
 * fallback), list tools (paged), follow `tools/list_changed`, reconnect with
 * backoff, cap stdio restarts, and report a plain-words status. Calls made
 * while the server is down, or in flight when it drops, fail with a clean
 * message; nothing in a reason or error carries a secret.
 */
import { Client, UnauthorizedError } from "@modelcontextprotocol/client";
import type {
  CallToolResult,
  ListResourcesResult,
  OAuthClientProvider,
  ReadResourceResult,
  Tool,
} from "@modelcontextprotocol/client";
import type { McpState, McpTransport } from "@spreissen/contracts";
import type { McpServerRecord } from "./config.ts";
import { resolveSecrets, type Scrubber } from "./secrets.ts";
import {
  buildTransport,
  transportPlan,
  type BuiltTransport,
  type ConcreteTransport,
} from "./transport.ts";

export interface McpToolDef {
  readonly remote: string;
  readonly title: string | null;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly readOnly: boolean;
  readonly destructive: boolean;
}

export interface ConnectionStatus {
  readonly state: McpState;
  readonly reason: string | null;
  readonly activeTransport: McpTransport | null;
  readonly serverName: string | null;
  readonly tools: readonly McpToolDef[];
  readonly hasResources: boolean;
}

export interface ConnectionTuning {
  readonly connectTimeoutMs: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  /** stdio: give up after this many crashes inside `restartWindowMs`. */
  readonly restartLimit: number;
  readonly restartWindowMs: number;
}

export const DEFAULT_TUNING: ConnectionTuning = {
  connectTimeoutMs: 20_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 5 * 60_000,
  restartLimit: 5,
  restartWindowMs: 10 * 60_000,
};

export interface ConnectionDeps {
  readonly record: () => McpServerRecord;
  readonly secrets: (record: McpServerRecord) => ReturnType<typeof resolveSecrets>;
  readonly workDir: () => string;
  /** The OAuth provider for `oauth` servers (null when the vault is off). */
  readonly oauth: () => OAuthClientProvider | null;
  readonly scrubber: Scrubber;
  readonly onChange: () => void;
  readonly tuning: ConnectionTuning;
}

export interface CallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

export interface McpConnection {
  readonly status: () => ConnectionStatus;
  readonly start: () => void;
  /** Manual reconnect: resets the restart budget. */
  readonly reconnect: () => Promise<void>;
  /** Stop for good (remove / disable / shutdown). */
  readonly close: () => Promise<void>;
  readonly call: (
    remote: string,
    args: Record<string, unknown>,
    options: CallOptions,
  ) => Promise<CallToolResult>;
  readonly listResources: (
    cursor: string | undefined,
    options: CallOptions,
  ) => Promise<ListResourcesResult>;
  readonly readResource: (uri: string, options: CallOptions) => Promise<ReadResourceResult>;
  readonly pid: () => number | null;
}

/** A call refused or broken in a way the model should see as plain words. */
export class McpCallError extends Error {}

const toolDefOf = (tool: Tool): McpToolDef => ({
  remote: tool.name,
  title: tool.title ?? tool.annotations?.title ?? null,
  description: tool.description ?? "",
  inputSchema: tool.inputSchema as Record<string, unknown>,
  readOnly: tool.annotations?.readOnlyHint === true,
  // The spec default for destructiveHint is true unless read-only.
  destructive:
    tool.annotations?.readOnlyHint !== true && tool.annotations?.destructiveHint !== false,
});

const statusOf = (cause: unknown): number | undefined => {
  const status = (cause as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status;
  const match = /\b(4\d\d|5\d\d)\b/.exec(String((cause as { message?: unknown })?.message ?? ""));
  return match === null ? undefined : Number(match[1]);
};

const isAuthFailure = (cause: unknown): boolean =>
  cause instanceof UnauthorizedError || statusOf(cause) === 401;

/** Plain words for a failed connect. */
const reasonOf = (cause: unknown, scrub: (text: string) => string, stderr: string): string => {
  const message = scrub(String((cause as { message?: unknown })?.message ?? cause)).slice(0, 200);
  const code = (cause as { code?: unknown })?.code;
  if (code === "ENOENT") return "the command was not found on this machine";
  if (code === "ECONNREFUSED" || /ECONNREFUSED/.test(message))
    return "nothing is listening at that address";
  const status = statusOf(cause);
  const http = status === undefined ? "" : ` (the server answered HTTP ${status})`;
  const tail = scrub(stderr).trim().split("\n").slice(-2).join(" ").slice(0, 200);
  return `${message.replace(/:\s*$/, "")}${http}${tail === "" ? "" : ` (stderr: ${tail})`}`;
};

interface Live {
  readonly client: Client;
  readonly built: BuiltTransport;
  readonly kind: ConcreteTransport;
}

/** One attempt across the transport plan; returns the live client or throws. */
const connectOnce = async (
  record: McpServerRecord,
  deps: ConnectionDeps,
  onToolsChanged: () => void,
): Promise<Live> => {
  const got = deps.secrets(record);
  if (!got.ok) throw new McpCallError(got.reason);
  deps.scrubber.add(got.secrets.forms);
  const oauth = record.auth.kind === "oauth" ? deps.oauth() : null;
  if (record.auth.kind === "oauth" && oauth === null) {
    throw new McpCallError("sign-in needs the vault (set VAULT_KEY)");
  }
  const plan = transportPlan(record);
  let first: unknown;
  for (const kind of plan) {
    const client = new Client(
      { name: "spreissen", version: "0.1.0" },
      { listChanged: { tools: { autoRefresh: false, onChanged: () => onToolsChanged() } } },
    );
    const built = buildTransport(kind, record, got.secrets, { cwd: deps.workDir, oauth });
    try {
      await client.connect(built.transport, { timeout: deps.tuning.connectTimeoutMs });
      return { client, built, kind };
    } catch (cause) {
      await client.close().catch(() => undefined);
      if (isAuthFailure(cause)) throw cause;
      first ??= cause;
      const status = statusOf(cause);
      // Only an HTTP-level refusal (4xx) suggests a legacy SSE server.
      if (
        kind === "http" &&
        plan.length > 1 &&
        status !== undefined &&
        status >= 400 &&
        status < 500
      )
        continue;
      if (kind === "sse" && first !== cause) throw first;
      Object.assign(cause as object, { stderrTail: built.stderrTail() });
      throw cause;
    }
  }
  throw first;
};

const listAllTools = async (client: Client): Promise<McpToolDef[]> => {
  const tools: McpToolDef[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await client.listTools(cursor === undefined ? {} : { cursor });
    tools.push(...result.tools.map(toolDefOf));
    cursor = result.nextCursor;
    if (cursor === undefined) break;
  }
  return tools;
};

/** The mutable state of one connection; the functions below drive it. */
interface ConnState {
  readonly deps: ConnectionDeps;
  live: Live | null;
  closed: boolean;
  generation: number;
  attempts: number;
  crashes: number[];
  timer: NodeJS.Timeout | null;
  status: ConnectionStatus;
}

const setStatus = (s: ConnState, change: Partial<ConnectionStatus>): void => {
  s.status = { ...s.status, ...change };
  s.deps.onChange();
};

const refreshTools = async (s: ConnState, gen: number): Promise<void> => {
  const current = s.live;
  if (current === null || gen !== s.generation) return;
  try {
    const tools = await listAllTools(current.client);
    if (gen === s.generation) setStatus(s, { tools });
  } catch {
    // A failed refresh keeps the last list; a dropped link reconnects.
  }
};

const scheduleRetry = (s: ConnState): void => {
  if (s.closed || s.timer !== null) return;
  const { tuning } = s.deps;
  if (s.deps.record().transport === "stdio") {
    const now = Date.now();
    s.crashes = [...s.crashes.filter((at) => now - at < tuning.restartWindowMs), now];
    if (s.crashes.length > tuning.restartLimit) {
      setStatus(s, {
        state: "failed",
        reason: `stopped after ${tuning.restartLimit} restarts in a few minutes; press Reconnect`,
      });
      return;
    }
  }
  const delay = Math.min(tuning.backoffMaxMs, tuning.backoffBaseMs * 2 ** s.attempts);
  s.attempts += 1;
  s.timer = setTimeout(
    () => {
      s.timer = null;
      void attempt(s);
    },
    delay * (0.8 + Math.random() * 0.4),
  );
  s.timer.unref();
};

const adopt = async (s: ConnState, gen: number, next: Live): Promise<void> => {
  s.live = next;
  next.client.onclose = () => {
    if (s.closed || gen !== s.generation) return;
    s.live = null;
    setStatus(s, { state: "connecting", reason: "the connection dropped; reconnecting" });
    scheduleRetry(s);
  };
  const tools = await listAllTools(next.client);
  s.attempts = 0;
  setStatus(s, {
    state: "connected",
    reason: null,
    activeTransport: next.kind,
    serverName: next.client.getServerVersion()?.name ?? null,
    tools,
    hasResources: next.client.getServerCapabilities()?.resources !== undefined,
  });
};

const fail = async (s: ConnState, record: McpServerRecord, cause: unknown): Promise<void> => {
  if (s.live !== null) await s.live.client.close().catch(() => undefined);
  s.live = null;
  if (isAuthFailure(cause)) {
    setStatus(s, {
      state: "needs_sign_in",
      reason:
        record.auth.kind === "oauth"
          ? "press Connect to sign in"
          : "the server refused the credentials (401)",
    });
    return;
  }
  const stderr = String((cause as { stderrTail?: unknown })?.stderrTail ?? "");
  setStatus(s, { state: "failed", reason: reasonOf(cause, s.deps.scrubber.scrub, stderr) });
  if (!(cause instanceof McpCallError)) scheduleRetry(s);
};

const attempt = async (s: ConnState): Promise<void> => {
  if (s.closed) return;
  const gen = ++s.generation;
  const record = s.deps.record();
  setStatus(s, { state: "connecting", reason: null });
  try {
    const next = await connectOnce(record, s.deps, () => void refreshTools(s, gen));
    if (s.closed || gen !== s.generation) {
      await next.client.close().catch(() => undefined);
      return;
    }
    await adopt(s, gen, next);
  } catch (cause) {
    if (s.closed || gen !== s.generation) return;
    await fail(s, record, cause);
  }
};

const ready = (s: ConnState): Client => {
  if (s.live === null || s.status.state !== "connected") {
    const why = s.status.reason === null ? "" : `: ${s.status.reason}`;
    throw new McpCallError(`this connector is ${s.status.state.replace(/_/g, " ")}${why}`);
  }
  return s.live.client;
};

/** Run one request; every failure becomes a clean, secret-free McpCallError. */
const guarded = async <T>(
  s: ConnState,
  run: (client: Client) => Promise<T>,
  options: CallOptions,
): Promise<T> => {
  const client = ready(s);
  try {
    return await run(client);
  } catch (cause) {
    if (options.signal?.aborted === true) throw new McpCallError("the call was cancelled");
    const message = s.deps.scrubber.scrub(
      String((cause as { message?: unknown })?.message ?? cause),
    );
    if (/timed? ?out/i.test(message)) {
      throw new McpCallError(
        `the server did not answer within ${Math.round(options.timeoutMs / 1000)}s`,
      );
    }
    if (/clos|disconnect|not connected/i.test(message) || s.live?.client !== client) {
      throw new McpCallError("the connector disconnected during the call; try again shortly");
    }
    throw new McpCallError(message.slice(0, 500));
  }
};

const stopLive = async (s: ConnState): Promise<void> => {
  s.generation += 1;
  if (s.timer !== null) clearTimeout(s.timer);
  s.timer = null;
  const current = s.live;
  s.live = null;
  if (current === null) return;
  const transport = current.built.transport as { terminateSession?: () => Promise<void> };
  await transport.terminateSession?.().catch(() => undefined);
  await current.client.close().catch(() => undefined);
};

const requestOptions = (options: CallOptions) => ({
  timeout: options.timeoutMs,
  ...(options.signal !== undefined ? { signal: options.signal } : {}),
});

export const makeConnection = (deps: ConnectionDeps): McpConnection => {
  const s: ConnState = {
    deps,
    live: null,
    closed: false,
    generation: 0,
    attempts: 0,
    crashes: [],
    timer: null,
    status: {
      state: "connecting",
      reason: null,
      activeTransport: null,
      serverName: null,
      tools: [],
      hasResources: false,
    },
  };
  return {
    status: () => s.status,
    start: () => void attempt(s),
    reconnect: async () => {
      await stopLive(s);
      s.attempts = 0;
      s.crashes = [];
      if (!s.closed) await attempt(s);
    },
    close: async () => {
      s.closed = true;
      await stopLive(s);
    },
    call: (remote, args, options) =>
      guarded(
        s,
        (client) =>
          client.callTool(
            { name: remote, arguments: args },
            requestOptions(options),
          ) as Promise<CallToolResult>,
        options,
      ),
    listResources: (cursor, options) =>
      guarded(
        s,
        (client) =>
          client.listResources(cursor === undefined ? {} : { cursor }, requestOptions(options)),
        options,
      ),
    readResource: (uri, options) =>
      guarded(s, (client) => client.readResource({ uri }, requestOptions(options)), options),
    pid: () => s.live?.built.pid() ?? null,
  };
};
