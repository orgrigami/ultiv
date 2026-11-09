/**
 * The server's calls into a home VM's browser broker (broker-install.ts):
 * one op per call through the VM's ROOT exec, the broker started on demand
 * (a `broker-down` answer starts it, then the call runs once more). Large
 * requests and anything secret (an upload's bytes, saved cookies, a vault
 * login) ride the stream's stdin, never a command line. A backend without a
 * root side (a test's fake) is called through its plain exec instead.
 */
import type { ShellBackend, ShellStream } from "../shell/backend.ts";
import {
  brokerCallScript,
  brokerRelayScript,
  brokerStartScript,
  brokerStdinCallScript,
  VM_BROKER_PATHS,
  type BrokerPaths,
} from "./broker-install.ts";

/** A broker reply: `ok`, or `ok: false` with a `kind` and an `error`. */
export type BrokerReply = {
  readonly ok?: boolean;
  readonly kind?: string;
  readonly error?: string;
} & {
  readonly [key: string]: unknown;
};

export interface BrokerCallOptions {
  readonly timeoutMs?: number;
  /** Send the request over stdin (large or secret payloads). */
  readonly viaStdin?: boolean;
}

export interface BrokerClient {
  readonly call: (
    backend: ShellBackend,
    request: Readonly<Record<string, unknown>>,
    options?: BrokerCallOptions,
  ) => Promise<BrokerReply>;
  /** A live relay (the cast): the caller writes the request line first. */
  readonly relay: (backend: ShellBackend, timeoutMs: number) => Promise<ShellStream>;
}

const CALL_TIMEOUT_MS = 90_000;
const START_TIMEOUT_MS = 90_000;

const lastJson = (stdout: string): BrokerReply | undefined => {
  const line = stdout
    .split("\n")
    .toReversed()
    .find((candidate) => candidate.trim().startsWith("{"));
  if (line === undefined) return undefined;
  try {
    return JSON.parse(line) as BrokerReply;
  } catch {
    return undefined;
  }
};

const down = (detail: string): BrokerReply => ({
  ok: false,
  kind: "broker-down",
  error: `the browser could not be reached${detail === "" ? "" : `: ${detail.slice(0, 200)}`}`,
});

/** Collect one stdin-fed call's reply off a root stream. */
const streamCall = async (
  open: (script: string, timeoutMs: number) => Promise<ShellStream>,
  script: string,
  line: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> => {
  const stream = await open(script, timeoutMs);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    stream.onChunk((chunk) => {
      const text = Buffer.from(chunk.data).toString("utf-8");
      if (chunk.stdout) stdout += text;
      else stderr = `${stderr}${text}`.slice(-2_000);
    });
    stream.onExit(() => resolve({ stdout, stderr }));
    void stream.write(`${line}\n`).catch(() => undefined);
  });
};

export const brokerClient = (paths: BrokerPaths = VM_BROKER_PATHS): BrokerClient => {
  const once = async (
    backend: ShellBackend,
    request: Readonly<Record<string, unknown>>,
    options: BrokerCallOptions,
  ): Promise<BrokerReply> => {
    const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;
    if (options.viaStdin === true && backend.rootStream !== undefined) {
      const { stdout, stderr } = await streamCall(
        (script, ms) => backend.rootStream?.(script, ms) ?? Promise.reject(new Error("no stream")),
        brokerStdinCallScript(paths),
        JSON.stringify(request),
        timeoutMs,
      );
      return lastJson(stdout) ?? down(stderr.trim());
    }
    const script = brokerCallScript(paths, request);
    const result =
      backend.rootExec !== undefined
        ? await backend.rootExec(script, timeoutMs)
        : await backend.exec(script, "/home", timeoutMs);
    return lastJson(result.stdout) ?? down(result.stderr.trim());
  };

  const start = async (backend: ShellBackend): Promise<BrokerReply> => {
    if (backend.rootExec === undefined) return down("this backend cannot start it");
    const result = await backend.rootExec(brokerStartScript(paths), START_TIMEOUT_MS);
    return lastJson(result.stdout) ?? down(result.stderr.trim());
  };

  return {
    call: async (backend, request, options = {}) => {
      const first = await once(backend, request, options);
      if (first.kind !== "broker-down") return first;
      const started = await start(backend);
      if (started.ok !== true) return started;
      return once(backend, request, options);
    },
    relay: async (backend, timeoutMs) => {
      if (backend.rootStream === undefined) {
        if (backend.stream === undefined) throw new Error("this backend cannot stream a live view");
        return backend.stream(brokerRelayScript(paths), "/home", timeoutMs);
      }
      const ping = await once(backend, { op: "status", bot: "" }, {});
      if (ping.kind === "broker-down") {
        const started = await start(backend);
        if (started.ok !== true) throw new Error(started.error ?? "the browser broker is down");
      }
      return backend.rootStream(brokerRelayScript(paths), timeoutMs);
    },
  };
};
