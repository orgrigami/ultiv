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
import { homedir } from "node:os";
import { join } from "node:path";
import { BASH_TARGETS, bashNodeNameOf, bashTargetOf } from "@spriessen/contracts";
import { bool, num, obj, oneOf, opt, str, type Static } from "@earendil-works/pi-schema";
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
import { sandboxShellBackend, scopeHash } from "../shell/sandbox-backend.ts";
import {
  nodeShellBackend,
  type NodeShellNode,
  type NodeShellTransport,
} from "../shell/node-backend.ts";

import { HOME, homeWorldOf, load, openSession, sandboxOptionsOf } from "./bash-session.ts";
import {
  EXEC_TIMEOUT_MS,
  HOST_TIMEOUT_MS,
  NODE_TIMEOUT_MS,
  execFailure,
  markerCwd,
  nodeUnpaired,
  present,
  runCallError,
  runOnHost,
  signalOf,
  syncOnce,
  wrapScript,
  type HostSession,
  type NodeSession,
} from "./bash-run.ts";
import {
  JOB_TIMEOUT_MS,
  JobBoard,
  JobKiller,
  MAX_JOBS_PER_CONVERSATION,
  jobFinishedText,
  jobStartedReply,
  jobsUnavailable,
  newJob,
  reloadWhileJob,
  tooManyJobs,
  type BashJobHost,
} from "./bash-jobs.ts";
import type { ResolvedWorld, SandboxSession } from "./bash-session.ts";
export { botFolderName, homeWorldOf, sandboxOptionsOf } from "./bash-session.ts";
export type { HomeWorld } from "./bash-session.ts";

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
  /**
   * Background jobs (bash-jobs.ts): the mind records them and wakes the
   * conversation with each result. Without it `background: true` is refused.
   */
  readonly jobs?: BashJobHost;
  /**
   * The kill switch for those jobs (work-tree stops reach it through the
   * mind's task wiring). Without it jobs still run to their cap; a work-tree
   * stop then only suppresses their wake.
   */
  readonly jobKiller?: JobKiller;
}

// ---- mode 1: the durable workspace in a microVM -------------------------

const TARGET_SCHEMA = oneOf(BASH_TARGETS);

const BashParams = obj(
  {
    script: str({
      description: "The bash script to run. Files persist in your workspace as artifacts.",
    }),
    target: opt(
      oneOf(BASH_TARGETS, {
        description:
          'Where to run: "vm" (default) in your home\'s sandboxed microVM, "host" directly on the ' +
          'server computer (privileged), or "node" on a node your owner paired. Each target needs ' +
          "its own approval: a rule for one target never approves another.",
      }),
    ),
    node: opt(
      str({
        description:
          'For target "node": the paired node\'s name. Leave it empty when your owner has ' +
          "exactly one paired node; naming it is required once there is more than one.",
      }),
    ),
    background: opt(
      bool({
        description:
          "Run it as a background job (up to 30 min, at most 3 at once): the call answers at " +
          "once with a job id and you are woken with the result. Use it for builds, test runs, " +
          "downloads, anything over a minute; keep quick commands in the foreground.",
      }),
    ),
  },
  { open: true },
);

type BashArgs = Static<typeof BashParams>;
type ToolReply = Awaited<ReturnType<Tool["execute"]>>;

/** A reply's text and exit code, for a finished job's wake. */
const outcomeOf = (reply: ToolReply): { text: string; exitCode: number } => {
  const code = (reply.structuredOutput as { exitCode?: unknown } | undefined)?.exitCode;
  return {
    text: (reply.output ?? []).map((part) => (part.type === "text" ? part.text : "")).join("\n"),
    exitCode: typeof code === "number" ? code : reply.isError === true ? 1 : 0,
  };
};

const sandboxTool = (
  dirOf: (conversationId: string) => string,
  backendOf: (dir: string, conversationId: string) => Promise<ResolvedWorld>,
  sessions: Map<string, Promise<SandboxSession>>,
  holder: ScopeHolder | undefined,
  onSharedWrite?: (conversationId: string, rows: readonly SharedWrite[]) => void,
  hostSessions?: Map<string, HostSession>,
  nodes?: NodeShellTransport,
  nodeSessions?: Map<string, NodeSession>,
  jobs?: BashJobHost,
  jobKiller?: JobKiller,
): Tool => {
  const board = new JobBoard();
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

  /** One call, foreground or as a background job (bash-jobs.ts). */
  const runCall = async (
    args: BashArgs,
    conversationId: string,
    run: { readonly signal: AbortSignal | undefined; readonly background: boolean },
  ): Promise<ToolReply> => {
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
      const result = await nodeShellBackend(nodes, node.id, run.signal).exec(
        wrapScript(args.script),
        session.cwd,
        run.background ? JOB_TIMEOUT_MS : NODE_TIMEOUT_MS,
      );
      const cwd = markerCwd(result.stderr);
      if (cwd !== undefined && !run.background) session.cwd = cwd;
      return present(result, "node", node.name, node.id);
    }
    if (target === "host") {
      if (hostSessions === undefined) return execFailure("bash", "host shell not wired");
      let session = hostSessions.get(conversationId);
      if (session === undefined) {
        session = { cwd: homedir() };
        hostSessions.set(conversationId, session);
      }
      const result = await runOnHost(
        args.script,
        session.cwd,
        run.background ? JOB_TIMEOUT_MS : HOST_TIMEOUT_MS,
      );
      const cwd = markerCwd(result.stderr);
      if (cwd !== undefined && !run.background) session.cwd = cwd;
      return present(result, "host");
    }
    const dir = dirOf(conversationId);
    let session: SandboxSession;
    try {
      session = await open(dir, conversationId);
      if (session.epoch !== workspaceEpoch(dir) || session.backend.needsPrepare?.() === true) {
        // A reload wipes the workspace root: never under a running job.
        if (board.inDir(dir) > (run.background ? 1 : 0)) return reloadWhileJob();
        await load(session, dir, conversationId);
      }
    } catch (cause) {
      sessions.delete(dir);
      return execFailure("bash", cause);
    }
    let result: ShellExecResult;
    try {
      result = await session.backend.exec(
        wrapScript(args.script),
        session.cwd,
        run.background ? JOB_TIMEOUT_MS : EXEC_TIMEOUT_MS,
        // Only a background job's kill signal: a foreground call's turn
        // abort (Redirect) deliberately lets its running tool round finish.
        run.background ? run.signal : undefined,
      );
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
    if (cwd !== undefined && !run.background) session.cwd = cwd;
    try {
      await syncOnce(session);
    } catch (cause) {
      // Nothing was deleted. A lost workspace re-prepares at the next call.
      if (cause instanceof WorkspaceLostError) session.epoch = -1;
      result = {
        ...result,
        stderr: `${result.stderr}\n[sync] warning: workspace sync to artifacts failed: ${String(cause)}`,
      };
    }
    return present(result, "vm");
  };

  /** Start a background job: answer now, wake the conversation with the result later. */
  const startJob = (args: BashArgs, conversationId: string): ToolReply => {
    const target = bashTargetOf(args);
    if (jobs === undefined) return jobsUnavailable();
    if (target === "invalid") return runCallError();
    if (board.count(conversationId) >= MAX_JOBS_PER_CONVERSATION) return tooManyJobs();
    const job = newJob(conversationId, target, args.script);
    const dir = target === "vm" ? dirOf(conversationId) : null;
    const tracked = jobKiller?.track(job);
    board.add(job, dir);
    jobs.started(job);
    void runCall(args, conversationId, { signal: tracked?.signal, background: true })
      .then(outcomeOf)
      .catch((cause: unknown) => ({ text: `failed: ${String(cause)}`, exitCode: 1 }))
      .then(({ text, exitCode }) => {
        board.remove(job, dir);
        jobKiller?.release(job.id);
        // A kill (work-tree stop) never wakes: the conversation was stopped,
        // and a result there would start a turn on cancelled work.
        if (tracked?.cancelled() === true) jobs.stopped(job);
        else jobs.finished(job, jobFinishedText(job, text, exitCode));
      });
    return jobStartedReply(job);
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
    structuredOutputSchema: obj(
      {
        stdout: str(),
        stderr: str(),
        exitCode: num(),
        target: TARGET_SCHEMA,
        node: opt(str()),
        nodeId: opt(str()),
        job: opt(str()),
      },
      { open: true },
    ),
    execute: async (args, api, context) => {
      const conversationId = String(api.conversationId);
      if (args.background === true) return startJob(args, conversationId);
      return runCall(args, conversationId, { signal: signalOf(context), background: false });
    },
  });
};

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
  // One VM per HOME (org or team) when the mind wires a home-scope
  // resolver: the sandbox is named by the home's scope dir and the bot works
  // in its own folder inside it. Without the resolver, the per-bot VM of
  // older embedders: the bot's dir names the VM and the workspace is /home.
  const backendOf = async (dir: string, conversationId: string): Promise<ResolvedWorld> => {
    const home = await holder?.get()?.homeScopeOf?.(conversationId);
    const world = homeWorldOf(dir, home);
    const staging = stagingOf(dir);
    const sandboxOptions = sandboxOptionsOf(world, options.image);
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
          options.jobs,
          options.jobKiller,
        ),
      ),
    ],
  });
};

/** Re-exported for tests and embedders that need the reference backend. */
export { localShellBackend };
