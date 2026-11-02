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
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { BASH_TARGETS, bashNodeNameOf, bashTargetOf, type BashTarget } from "@spriessen/contracts";
import { Type } from "typebox";
import { definePlugin, toolCapability, type Plugin } from "../plugin.ts";
import { defineTool, type Tool } from "../tool.ts";
import { DurableFs } from "../fs/durable-fs.ts";
import { workspaceEpoch } from "../fs/workspace-epoch.ts";
import { scopeDir, type HomeScope, type SandboxUser, type ScopeHolder } from "./vault.ts";
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

const MAX_OUTPUT_CHARS = 20_000;
const HOME = "/home";
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

/**
 * The guest world one conversation's `bash` maps to: which VM (its sandbox
 * name is `sandboxNameOf(vmDir)`), where the bot's workspace sits inside it,
 * and the home's shared-folder gid when the home provisions one. Without a
 * home scope this is the per-bot VM of older embedders: the bot's whole dir
 * is the scope and the workspace is all of `/home`.
 */
export interface HomeWorld {
  readonly vmDir: string;
  readonly guestRoot: string;
  readonly sharedGid?: number;
  /**
   * The org-wide folder (slice 2c): mounted at `/home/org-shared` in every
   * VM, read-write for an org bot, read-only for a department bot.
   */
  readonly orgShared?: HomeScope["orgShared"];
  /** The department's durable store backing `/home/shared` (slice 2d). */
  readonly sharedStore?: string;
  /** The org VM's department folders (slice 2d), org bots only. */
  readonly deptShared?: HomeScope["deptShared"];
  /** The bot's own Linux user in the VM (slice 2b), when the home gives one. */
  readonly user?: SandboxUser;
  /** The home's network allowlist (slice 3): named hosts, everything else denied. */
  readonly netAllowlist?: readonly string[];
  /** Full network access (owner opt-in): the allowlist is ignored. */
  readonly netOpen?: boolean;
  /** The writable shared folders' size caps (fix 2). */
  readonly caps?: HomeScope["caps"];
  /** The home's stored VM size (slice 4): cpus and memory at creation. */
  readonly vm?: HomeScope["vm"];
}

/** Safe folder name for the bot inside the shared VM; an opaque hash otherwise. */
export const botFolderName = (dir: string): string => {
  const base = basename(dir);
  // "shared" is reserved: it is every VM's /home/shared.
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(base) && base !== "shared"
    ? base
    : scopeHash(dir);
};

/** The pure mapping from a conversation's bot dir and home scope to its VM world. */
export const homeWorldOf = (botDir: string, home: HomeScope | undefined): HomeWorld => {
  if (home === undefined) return { vmDir: botDir, guestRoot: HOME };
  return {
    vmDir: home.dir,
    guestRoot: `${HOME}/${botFolderName(botDir)}`,
    ...(home.sharedGid === undefined ? {} : { sharedGid: home.sharedGid }),
    ...(home.orgShared === undefined ? {} : { orgShared: home.orgShared }),
    ...(home.sharedStore === undefined ? {} : { sharedStore: home.sharedStore }),
    ...(home.deptShared === undefined ? {} : { deptShared: home.deptShared }),
    ...(home.user === undefined ? {} : { user: home.user }),
    ...(home.netAllowlist === undefined ? {} : { netAllowlist: home.netAllowlist }),
    ...(home.netOpen === undefined ? {} : { netOpen: home.netOpen }),
    ...(home.caps === undefined ? {} : { caps: home.caps }),
    ...(home.vm === undefined ? {} : { vm: home.vm }),
  };
};

/** Appends an exit-code-preserving exec-boundary marker that reports $PWD. */
const wrapScript = (script: string): string =>
  `${script}\n__spriessen_rc=$?; echo "${CWD_MARKER}$PWD" 1>&2; exit $__spriessen_rc`;

const truncate = (text: string): string => {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… [truncated ${text.length - MAX_OUTPUT_CHARS} chars]`;
};

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

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

const execFailure = (what: string, cause: unknown) => ({
  output: [{ type: "text" as const, text: `${what} failed: ${String(cause)}` }],
  isError: true as const,
});

// ---- mode 1: the durable workspace in a microVM -------------------------

/** One call's resolved home world: its identity, and how to build its backend. */
interface ResolvedWorld {
  readonly key: string;
  readonly make: () => { readonly backend: ShellBackend; readonly guestRoot: string };
}

interface SandboxSession {
  durable: DurableFs;
  readonly backend: ShellBackend;
  /** The resolved home world this backend was built for (re-checked every call). */
  readonly worldKey: string;
  /** workspaceEpoch(dir) when the VM was last loaded; file_edit/file_delete bump it. */
  epoch: number;
  /** sha256 per workspace-relative path, the sync loop's diff basis. */
  hashes: Map<string, string>;
  cwd: string;
}

/**
 * Boots the session: load the artifact tree, reset the VM workspace to it,
 * seed the hash map. The artifact store mirrors the VM after every sync, so
 * re-pushing is idempotent (and heals a crashed VM's lost disk).
 */
const openSession = async (
  dir: string,
  conversationId: string,
  backend: ShellBackend,
  guestRoot: string,
  worldKey: string,
): Promise<SandboxSession> => {
  const session: SandboxSession = {
    durable: new DurableFs({ dir, conversationId }),
    backend,
    worldKey,
    epoch: workspaceEpoch(dir),
    hashes: new Map(),
    cwd: guestRoot,
  };
  await load(session, dir, conversationId);
  return session;
};

/** Re-read the tree from disk and reset the VM to it (also after another tool changed it). */
const load = async (
  session: SandboxSession,
  dir: string,
  conversationId: string,
): Promise<void> => {
  session.epoch = workspaceEpoch(dir);
  session.durable = new DurableFs({ dir, conversationId });
  const files = [];
  const hashes = new Map<string, string>();
  for (const path of session.durable.allFilePaths()) {
    const bytes = await session.durable.readFileBuffer(path);
    const rel = path.slice(1); // "/a/b" -> "a/b"
    files.push({ path: rel, bytes });
    hashes.set(rel, sha256(bytes));
  }
  await session.backend.prepare(files);
  session.hashes = hashes;
};

/**
 * VM → artifact store: upsert changed files, delete removed ones. Deletion
 * needs a TRUSTED listing: a failed listing throws before anything is
 * deleted, and a lost workspace (recreated VM — `WorkspaceLostError`) is
 * never read as "the bot deleted everything"; the next call re-prepares.
 */
const reconcile = async (session: SandboxSession): Promise<void> => {
  const seen = new Set<string>(await session.backend.listFiles());
  for (const rel of seen) {
    const bytes = await session.backend.readFile(rel);
    const hash = sha256(bytes);
    if (session.hashes.get(rel) !== hash) {
      await session.durable.writeFile(`/${rel}`, bytes);
      session.hashes.set(rel, hash);
    }
  }
  for (const rel of session.hashes.keys()) {
    if (!seen.has(rel)) {
      await session.durable.rm(`/${rel}`);
      session.hashes.delete(rel);
    }
  }
};

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
      'changes are permanent — only when the task genuinely needs the host); and "node" on a ' +
      "node your owner paired (their other machine). " +
      "In the VM: real Linux in a sandbox: coreutils, pipes, grep, jq, tar, python. The " +
      "network is OFF by default: only the hosts your owner allowlisted for this home are " +
      "reachable, so apt-get, pip or curl work only when the policy allows their hosts (for " +
      "apt-get, the distribution mirrors); a refused connection means the host is not " +
      "allowed, not that it is down (if every host is refused, ask whether this home's " +
      "network has been opened fully). Shared folders have size caps; over a cap the folder " +
      "turns read-only. Every file you create or change under " +
      HOME +
      " is an artifact: it persists across restarts and the user can see it. The folder " +
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
    execute: async (args, api) => {
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
        const result = await nodeShellBackend(nodes, node.id).exec(
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
        'name the node with the "node" field — a name that matches no single paired node ' +
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
