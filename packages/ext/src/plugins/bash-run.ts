/**
 * The bash tool's plumbing, shared by every target: the exec-boundary
 * wrapper that reports the working directory, output shaping (truncation,
 * the where-it-ran line, the structured result), the host runner, the
 * per-conversation host and node working state, and the serialized
 * workspace sync a background job and a foreground call share.
 */
import { execFile } from "node:child_process";
import type { BashTarget } from "@spriessen/contracts";
import type { ShellExecResult } from "../shell/backend.ts";
import { reconcile, type SandboxSession } from "./bash-session.ts";

export const MAX_OUTPUT_CHARS = 20_000;
export const EXEC_TIMEOUT_MS = 180_000;
export const HOST_TIMEOUT_MS = 120_000;
export const NODE_TIMEOUT_MS = 120_000;
export const CWD_MARKER = "__SPRIESSEN_CWD__";

/** Appends an exit-code-preserving exec-boundary marker that reports $PWD. */
export const wrapScript = (script: string): string =>
  `${script}\n__spriessen_rc=$?; echo "${CWD_MARKER}$PWD" 1>&2; exit $__spriessen_rc`;

export const truncate = (text: string): string => {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… [truncated ${text.length - MAX_OUTPUT_CHARS} chars]`;
};

/** The where-it-ran line every result carries, per target. */
export const whereText = (target: BashTarget, node: string | null): string =>
  target === "vm"
    ? "(ran in the home VM)"
    : target === "host"
      ? "(ran on the host)"
      : `(ran on node ${node ?? "?"})`;

export const present = (
  result: ShellExecResult,
  target: BashTarget,
  node: string | null = null,
  nodeId?: string,
) => {
  const stderr = truncate(
    result.stderr
      .split("\n")
      .filter((line) => !line.startsWith(CWD_MARKER))
      .join("\n")
      .replace(/^\n/, ""),
  );
  const stdout = truncate(result.stdout);
  const parts = [
    ...(stdout === "" ? [] : [stdout]),
    ...(stderr === "" ? [] : [`[stderr] ${stderr}`]),
  ];
  return {
    output: [
      {
        type: "text" as const,
        text:
          parts.length === 0
            ? `(exit ${result.exitCode}, no output) ${whereText(target, node)}`
            : `${parts.join("\n")}\n${whereText(target, node)}`,
      },
    ],
    structuredOutput: {
      stdout,
      stderr,
      exitCode: result.exitCode,
      target,
      ...(node !== null ? { node } : {}),
      ...(nodeId !== undefined ? { nodeId } : {}),
    },
  };
};

/** Pulls the marker's PWD out of stderr; undefined when absent. */
export const markerCwd = (stderr: string): string | undefined => {
  const marker = stderr
    .split("\n")
    .reverse()
    .find((line) => line.startsWith(CWD_MARKER));
  return marker !== undefined && marker.slice(CWD_MARKER.length).startsWith("/")
    ? marker.slice(CWD_MARKER.length)
    : undefined;
};

/** The asking turn's abort signal (chord's Context; tests pass none). */
export const signalOf = (context: unknown): AbortSignal | undefined => {
  const signal = (context as { readonly abortSignal?: unknown } | undefined)?.abortSignal;
  return signal instanceof AbortSignal ? signal : undefined;
};

export const execFailure = (what: string, cause: unknown) => ({
  output: [{ type: "text" as const, text: `${what} failed: ${String(cause)}` }],
  isError: true as const,
});

/** Serialized syncs per VM session: a job's sync never interleaves with a call's. */
const syncChains = new WeakMap<SandboxSession, Promise<void>>();

export const syncOnce = (session: SandboxSession): Promise<void> => {
  const next = (syncChains.get(session) ?? Promise.resolve()).then(
    () => reconcile(session),
    () => reconcile(session),
  );
  syncChains.set(
    session,
    next.catch(() => undefined),
  );
  return next;
};

export const runCallError = () =>
  execFailure("bash", 'unknown target: use "vm" (default), "host" or "node"');

export interface HostSession {
  cwd: string;
}

/** One conversation's node working state: the node it is on and its cwd there. */
export interface NodeSession {
  nodeId: string;
  name: string;
  cwd: string;
}

/**
 * The structured, owner-actionable error for every unresolvable node call:
 * no pairing, an unknown or ambiguous name, or a revoked row — the fix is
 * the owner's (pair in Settings → Nodes, or name a paired node).
 */
export const nodeUnpaired = () => ({
  output: [
    {
      type: "text" as const,
      text:
        'no node is paired for target "node": ask your owner to pair one in Settings → Nodes ' +
        "(pairing mints a token their node agent dials in with); once more than one is paired, " +
        'name the node with the "node" field; a name that matches no single paired node ' +
        "answers this same error",
    },
  ],
  isError: true as const,
});

export const runOnHost = (
  script: string,
  cwd: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<ShellExecResult> =>
  new Promise((resolve) => {
    const child = execFile(
      "/bin/bash",
      ["-c", wrapScript(script)],
      { cwd, timeout: timeoutMs, maxBuffer: 8_000_000, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        let exitCode = 0;
        if (error !== null) {
          const code = (error as NodeJS.ErrnoException).code;
          exitCode = typeof code === "number" ? code : error.killed === true ? 124 : 1;
        }
        resolve({
          stdout,
          stderr,
          exitCode,
        });
      },
    );
    const onStop = (): void => {
      child.kill("SIGKILL");
    };
    // A signal that was aborted before this exec started must still kill.
    if (abortSignal !== undefined) {
      if (abortSignal.aborted) onStop();
      else abortSignal.addEventListener("abort", onStop, { once: true });
    }
    child.once("close", () => abortSignal?.removeEventListener("abort", onStop));
  });
