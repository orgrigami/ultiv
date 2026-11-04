/**
 * The bash tool's `node` target: a ShellBackend over the agent transport,
 * consumed through the narrow `NodeShellTransport` facade so ext never
 * imports mind (the mind builds the facade from its node registry + the
 * injected transport). On a node the working dir IS the machine's real
 * filesystem — the owner's repos, not a bot workspace — so `prepare` is a
 * no-op and the artifact sync loop does not apply here: the phase-4
 * sync-delete hazard (deleting artifacts off an untrusted listing) has
 * nothing to delete into, and files the script writes are already wherever
 * they belong. `listFiles`/`readFile` refuse for the same reason: there is
 * no `/home`-rooted workspace to walk, only the caller's own cwd.
 */
import type { ShellBackend, ShellExecResult } from "./backend.ts";

/** One paired node as the bash tool sees it: identity + confinement roots. */
export interface NodeShellNode {
  readonly id: string;
  readonly name: string;
  readonly roots: readonly string[];
}

export interface NodeShellExecRequest {
  readonly script: string;
  readonly cwd?: string;
  readonly timeoutMs: number;
  /** The asking turn's signal: an abort cancels the script on the node. */
  readonly signal?: AbortSignal;
}

export interface NodeShellExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * The node registry + agent transport, seen from the bash tool: resolve a
 * call's node (by name, or the owner's single paired node) and run one exec
 * on it. The mind wires this from `resolveNodeId`/`nodeOf` + the transport;
 * tests substitute fakes.
 */
export interface NodeShellTransport {
  readonly resolve: (owner: string, name: string | null) => Promise<NodeShellNode | undefined>;
  readonly exec: (nodeId: string, request: NodeShellExecRequest) => Promise<NodeShellExecResult>;
}

const notAWorkspace = (op: string): never => {
  throw new Error(
    `${op} is not supported on a node: its working directory is the machine's real ` +
      "filesystem, not the bot's artifact workspace, so the file sync does not apply",
  );
};

/** One node's backend: execs ride the transport, everything workspace-shaped refuses. */
export const nodeShellBackend = (
  transport: NodeShellTransport,
  nodeId: string,
  signal?: AbortSignal,
): ShellBackend => ({
  // The node's filesystem is already the durable world: nothing to reset.
  prepare: async () => undefined,
  exec: async (script, cwd, timeoutMs): Promise<ShellExecResult> => {
    const result = await transport.exec(nodeId, {
      script,
      ...(cwd !== undefined ? { cwd } : {}),
      timeoutMs,
      ...(signal !== undefined ? { signal } : {}),
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.exitCode,
    };
  },
  listFiles: async () => notAWorkspace("listFiles"),
  readFile: async () => notAWorkspace("readFile"),
});
