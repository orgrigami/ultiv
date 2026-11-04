/**
 * The bash faculty, ONE tool over one plugin, with three targets:
 *
 * `bash` (default `target: "vm"`) — the durable workspace as a shell,
 * executed in a hardware-isolated microsandbox microVM (real Linux:
 * coreutils, python, node, network). The workspace's artifact tree is the
 * source of truth: each call pushes it into the VM's /home, runs the script,
 * then syncs every file the script touched back into the artifact store —
 * so VM files ARE artifacts: visible in `artifact_list`, served by the web
 * UI, kept across restarts. Gated as a whole: a script can delete or
 * overwrite any file in the profile's tree (artifact_delete's gate would
 * otherwise be bypassed), so each call waits for approval unless
 * policies.autoApprove lists `bash` — a grant that covers the vm target
 * ONLY (see auto-approve.ts in the mind).
 *
 * `target: "host"` — the privileged shell that runs DIRECTLY on the host
 * computer running this server, the old standalone `bash_host` tool merged
 * in. No sandbox, no isolation, the whole filesystem is reachable. Gated per
 * call and per target: bare grants and patterns never cover it; the only
 * list entry for it is the owner's own exact script
 * (`bash@host:=<script>`, see auto-approve.ts), the host-access switch must
 * be on, and Jev never decides it.
 *
 * `target: "node"` — a paired node agent (the owner's other machine). Same
 * rule shape as host (`bash@node:<nodeId>:=<script>`), the same switch, and
 * it additionally needs a paired node; without one the call fails with a
 * structured, owner-actionable error. The backend arrives with the node
 * transport; until a node is paired every node call answers that error.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { BASH_TARGETS, bashNodeNameOf, bashTargetOf, type BashTarget } from "@spriessen/contracts";
import { Type } from "typebox";
import { definePlugin, toolCapability, type Plugin } from "../plugin.ts";
import { defineTool, type Tool } from "../tool.ts";
import { workspaceEpoch } from "../fs/workspace-epoch.ts";
import { scopeDir, type ScopeHolder } from "./vault.ts";
import { artifactsDir } from "./artifacts.ts";
import {
  localShellBackend,
  WorkspaceLostError,
  type ShellBackend,
  type ShellExecResult,
  type SharedWrite,
} from "../shell/backend.ts";
import { sandboxNameOf, sandboxShellBackend, scopeHash } from "../shell/sandbox-backend.ts";
import {
  nodeShellBackend,
  type NodeShellNode,
  type NodeShellTransport,
} from "../shell/node-backend.ts";

import { HOME, homeWorldOf, load, openSession, reconcile } from "./bash-session.ts";
import type { ResolvedWorld, SandboxSession } from "./bash-session.ts";
export { botFolderName, homeWorldOf } from "./bash-session.ts";
export type { HomeWorld } from "./bash-session.ts";

const MAX_OUTPUT_CHARS = 20_000;
const EXEC_TIMEOUT_MS = 180_000;
const HOST_TIMEOUT_MS = 120_000;
const NODE_TIMEOUT_MS = 120_000;
const CWD_MARKER = "__SPRIESSEN_CWD__";

export interface BashOptions {
  /** Workspace root; default ARTIFACTS_DIR. */
  readonly root?: string;
  /** Profile-scope resolver; when set, each conversation works in its profile's tree. */
  readonly holder?: ScopeHolder;
  /** OCI image for the microVM; default `ultiv-sandbox:latest`, `SPRIESSEN_SANDBOX_IMAGE` overrides. */
  readonly image?: string;
  /**
   * Backend factory override, keyed by the scope's absolute workspace dir.
   * Tests inject `localShellBackend`; production defaults to the microsandbox
   * microVM (`sandboxShellBackend`). `homeDir` is the plain host directory
   * standing in for the workspace root inside the VM (`guestRoot` — the bot's
   * own folder when the VM is shared by a home, `/home` otherwise).
   */
  readonly backend?: (dir: string, homeDir: string, guestRoot: string) => ShellBackend;
  /**
   * The paired-node registry + agent transport behind the `node` target.
   * The mind builds it from its node registry and the /agent dial; without
   * it every node call answers the owner-actionable "no node" error.
   */
  readonly nodes?: NodeShellTransport;
}

/** Appends an exit-code-preserving exec-boundary marker that reports $PWD. */
const wrapScript = (script: string): string =>
  `${script}\n__spriessen_rc=$?; echo "${CWD_MARKER}$PWD" 1>&2; exit $__spriessen_rc`;

const truncate = (text: string): string => {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… [truncated ${text.length - MAX_OUTPUT_CHARS} chars]`;
};

/** The where-it-ran line every result carries, per target. */
const whereText = (target: BashTarget, node: string | null): string =>
  target === "vm"
    ? "(ran in the home VM)"
    : target === "host"
      ? "(ran on the host)"
      : `(ran on node ${node ?? "?"})`;

const present = (
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
const markerCwd = (stderr: string): string | undefined => {
  const marker = stderr
    .split("\n")
    .reverse()
    .find((line) => line.startsWith(CWD_MARKER));
  return marker !== undefined && marker.slice(CWD_MARKER.length).startsWith("/")
    ? marker.slice(CWD_MARKER.length)
    : undefined;
};

/** The asking turn's abort signal (chord's Context; tests pass none). */
const signalOf = (context: unknown): AbortSignal | undefined => {
  const signal = (context as { readonly abortSignal?: unknown } | undefined)?.abortSignal;
  return signal instanceof AbortSignal ? signal : undefined;
};

const execFailure = (what: string, cause: unknown) => ({
  output: [{ type: "text" as const, text: `${what} failed: ${String(cause)}` }],
  isError: true as const,
});

// ---- mode 1: the durable workspace in a microVM -------------------------

const TARGET_SCHEMA = Type.Union(BASH_TARGETS.map((target) => Type.Literal(target)));

const BashParams = Type.Object({
  script: Type.String({
    description: "The bash script to run. Files persist in your workspace as artifacts.",
  }),
  target: Type.Optional(
    Type.Union(
      BASH_TARGETS.map((target) => Type.Literal(target)),
      {
        description:
          'Where to run: "vm" (default) in your home\'s sandboxed microVM, "host" directly on the ' +
          'server computer (privileged), or "node" on a node your owner paired. Each target needs ' +
          "its own approval: a rule for one target never approves another.",
      },
    ),
  ),
  node: Type.Optional(
    Type.String({
      description:
        'For target "node": the paired node\'s name. Leave it empty when your owner has ' +
        "exactly one paired node; naming it is required once there is more than one.",
    }),
  ),
});

const sandboxTool = (
  dirOf: (conversationId: string) => string,
  backendOf: (dir: string, conversationId: string) => Promise<ResolvedWorld>,
  sessions: Map<string, Promise<SandboxSession>>,
  holder: ScopeHolder | undefined,
  onSharedWrite?: (conversationId: string, rows: readonly SharedWrite[]) => void,
  hostSessions?: Map<string, HostSession>,
  nodes?: NodeShellTransport,
  nodeSessions?: Map<string, NodeSession>,
): Tool => {
  // The home world is resolved on EVERY call: a cached session keeps its
  // backend only while the world it was built for (VM name, allowlist,
  // size, mounts, user) is still the current one — a stale session would
  // recreate the VM back to an old spec.
  const open = async (dir: string, conversationId: string): Promise<SandboxSession> => {
    const world = await backendOf(dir, conversationId);
    const existing = sessions.get(dir);
    if (existing !== undefined) {
      const session = await existing.catch(() => undefined);
      if (session !== undefined && session.worldKey === world.key) return session;
      if (sessions.get(dir) === existing) sessions.delete(dir);
    }
    const again = sessions.get(dir);
    if (again !== undefined) return again;
    const { backend, guestRoot } = world.make();
    const creating = openSession(dir, conversationId, backend, guestRoot, world.key);
    creating.catch(() => sessions.delete(dir));
    sessions.set(dir, creating);
    return creating;
  };

  return defineTool({
    name: "bash",
    gated: true,
    description:
      `Run a bash script. Three targets: "vm" (the DEFAULT) in your own workspace inside ` +
      `your home's microVM (the working directory; on a single-bot install that is the whole VM ` +
      `at ${HOME}); "host" DIRECTLY on the host computer running this server (privileged, no ` +
      "sandbox: the whole real filesystem, configuration, and every program are reachable, and " +
      'changes are permanent; use it only when the task genuinely needs the host); and "node" on a ' +
      "node your owner paired (their other machine). " +
      "In the VM: real Linux in a sandbox: coreutils, pipes, grep, jq, tar, python. The " +
      "network is OFF by default: only the hosts your owner allowlisted for this home are " +
      "reachable, so apt-get, pip or curl work only when the policy allows their hosts (for " +
      "apt-get, the distribution mirrors); a refused connection means the host is not " +
      "allowed, not that it is down (if every host is refused, ask whether this home's " +
      "network has been opened fully). Shared folders have size caps; over a cap the folder " +
      "turns read-only. Every file you create or change under " +
      HOME +
      " is an artifact: it persists across restarts and your owner can see it. The folder " +
      "/home/org-shared is shared with the whole org: never write vault values, tokens or " +
      "credentials there. Working directory " +
      "carries over between calls (per target). Each call waits for your owner's approval " +
      "(unless they chose always-allow, and always-allow for host and node covers THAT exact " +
      "script on THAT target only): batch work into few scripts, and first say in a sentence " +
      "what the script will change and where it will run. Never delete or overwrite files you " +
      "did not create for the current task without asking.",
    parameters: BashParams,
    structuredOutputSchema: Type.Object({
      stdout: Type.String(),
      stderr: Type.String(),
      exitCode: Type.Number(),
      target: TARGET_SCHEMA,
      node: Type.Optional(Type.String()),
      nodeId: Type.Optional(Type.String()),
    }),
    execute: async (args, api, context) => {
      const conversationId = String(api.conversationId);
      const target = bashTargetOf(args);
      if (target === "invalid") {
        return execFailure("bash", 'unknown target: use "vm" (default), "host" or "node"');
      }
      if (target === "node") {
        if (nodes === undefined || nodeSessions === undefined) return nodeUnpaired();
        const scope = holder?.get()?.scopeOf(conversationId);
        if (scope === undefined)
          return execFailure("bash", "this conversation has no profile scope for a node call");
        let node: NodeShellNode;
        try {
          const resolved = await nodes.resolve(scope.owner, bashNodeNameOf(args));
          if (resolved === undefined) return nodeUnpaired();
          node = resolved;
        } catch (cause) {
          return execFailure("bash", cause);
        }
        let session = nodeSessions.get(conversationId);
        if (session === undefined || session.nodeId !== node.id) {
          // The default cwd is the node's first allowed root; a paired node
          // always has one (the registry refuses empty root lists).
          session = { nodeId: node.id, name: node.name, cwd: node.roots[0] ?? "/" };
          nodeSessions.set(conversationId, session);
        }
        const result = await nodeShellBackend(nodes, node.id, signalOf(context)).exec(
          wrapScript(args.script),
          session.cwd,
          NODE_TIMEOUT_MS,
        );
        const cwd = markerCwd(result.stderr);
        if (cwd !== undefined) session.cwd = cwd;
        return present(result, "node", node.name, node.id);
      }
      if (target === "host") {
        if (hostSessions === undefined) return execFailure("bash", "host shell not wired");
        let session = hostSessions.get(conversationId);
        if (session === undefined) {
          session = { cwd: homedir() };
          hostSessions.set(conversationId, session);
        }
        const result = await runOnHost(args.script, session.cwd, HOST_TIMEOUT_MS);
        const cwd = markerCwd(result.stderr);
        if (cwd !== undefined) session.cwd = cwd;
        return present(result, "host");
      }
      const dir = dirOf(conversationId);
      let session: SandboxSession;
      try {
        session = await open(dir, conversationId);
        if (session.epoch !== workspaceEpoch(dir) || session.backend.needsPrepare?.() === true) {
          await load(session, dir, conversationId);
        }
      } catch (cause) {
        sessions.delete(dir);
        return execFailure("bash", cause);
      }
      let result: ShellExecResult;
      try {
        result = await session.backend.exec(wrapScript(args.script), session.cwd, EXEC_TIMEOUT_MS);
      } catch (cause) {
        return execFailure("bash", cause);
      }
      if (result.sharedWrites !== undefined && result.sharedWrites.length > 0) {
        try {
          onSharedWrite?.(conversationId, result.sharedWrites);
        } catch {
          // Auditing never fails the call.
        }
      }
      result = { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
      const cwd = markerCwd(result.stderr);
      if (cwd !== undefined) session.cwd = cwd;
      try {
        await reconcile(session);
      } catch (cause) {
        // Nothing was deleted. A lost workspace re-prepares at the next call.
        if (cause instanceof WorkspaceLostError) session.epoch = -1;
        result = {
          ...result,
          stderr: `${result.stderr}\n[sync] warning: workspace sync to artifacts failed: ${String(cause)}`,
        };
      }
      return present(result, "vm");
    },
  });
};

// ---- the privileged host shell (the `host` target) -----------------------

interface HostSession {
  cwd: string;
}

/** One conversation's node working state: the node it is on and its cwd there. */
interface NodeSession {
  nodeId: string;
  name: string;
  cwd: string;
}

/**
 * The structured, owner-actionable error for every unresolvable node call:
 * no pairing, an unknown or ambiguous name, or a revoked row — the fix is
 * the owner's (pair in Settings → Nodes, or name a paired node).
 */
const nodeUnpaired = () => ({
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

const runOnHost = (script: string, cwd: string, timeoutMs: number): Promise<ShellExecResult> =>
  new Promise((resolve) => {
    execFile(
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
  });

/** The bash plugin: one shell, three targets — the home VM, the host, a paired node. */
export const bashPlugin = (options: BashOptions = {}): Plugin => {
  const root = options.root ?? artifactsDir();
  const holder = options.holder;
  const dirOf = (conversationId: string): string =>
    holder === undefined ? root : scopeDir(holder, conversationId, root);
  // Keyed by SCOPE DIRECTORY, not conversation: one shared tree per profile,
  // so every conversation of a bot sees the same durable files.
  const sessions = new Map<string, Promise<SandboxSession>>();
  const hostSessions = new Map<string, HostSession>();
  const nodeSessions = new Map<string, NodeSession>();
  const stagingOf = (dir: string): string => join(root, "..", "bash-home", scopeHash(dir));
  // One VM per HOME (org or department) when the mind wires a home-scope
  // resolver: the sandbox is named by the home's scope dir and the bot works
  // in its own folder inside it. Without the resolver, the per-bot VM of
  // older embedders: the bot's dir names the VM and the workspace is /home.
  const backendOf = async (dir: string, conversationId: string): Promise<ResolvedWorld> => {
    const home = await holder?.get()?.homeScopeOf?.(conversationId);
    const world = homeWorldOf(dir, home);
    const staging = stagingOf(dir);
    const sandboxOptions = {
      name: sandboxNameOf(world.vmDir),
      ...(options.image === undefined ? {} : { image: options.image }),
      guestRoot: world.guestRoot,
      ...(world.sharedGid === undefined ? {} : { sharedGid: world.sharedGid }),
      ...(world.orgShared === undefined ? {} : { orgShared: world.orgShared }),
      ...(world.sharedStore === undefined ? {} : { sharedStore: world.sharedStore }),
      ...(world.deptShared === undefined ? {} : { deptShared: world.deptShared }),
      ...(world.user === undefined ? {} : { user: world.user }),
      ...(world.netAllowlist === undefined ? {} : { netAllowlist: world.netAllowlist }),
      ...(world.netOpen === undefined ? {} : { netOpen: world.netOpen }),
      ...(world.vm === undefined ? {} : { vm: world.vm }),
      ...(world.caps === undefined ? {} : { caps: world.caps }),
    };
    return {
      key: JSON.stringify(sandboxOptions),
      make: () => ({
        backend:
          options.backend !== undefined
            ? options.backend(dir, staging, world.guestRoot)
            : sandboxShellBackend(sandboxOptions)(staging),
        guestRoot: world.guestRoot,
      }),
    };
  };
  return definePlugin({
    id: "ultiv.bash",
    version: "4.0.0",
    description:
      "One shell, three targets: a sandboxed microVM over the durable workspace (files written here are artifacts, the default), a privileged shell on the host computer, and a paired node agent — each target gated on its own terms.",
    capabilities: [
      toolCapability(
        sandboxTool(
          dirOf,
          backendOf,
          sessions,
          holder,
          (conversationId, rows) => holder?.get()?.sharedWrite?.(conversationId, rows),
          hostSessions,
          options.nodes,
          nodeSessions,
        ),
      ),
    ],
  });
};

/** Re-exported for tests and embedders that need the reference backend. */
export { localShellBackend };
