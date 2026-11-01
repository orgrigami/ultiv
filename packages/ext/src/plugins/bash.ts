/**
 * The bash faculty, two modes over one plugin:
 *
 * 1. `bash` — the durable workspace as a shell, executed in a
 *    hardware-isolated microsandbox microVM (real Linux: coreutils, python,
 *    node, network). The workspace's artifact tree is the source of truth:
 *    each call pushes it into the VM's /home, runs the script, then syncs
 *    every file the script touched back into the artifact store — so VM
 *    files ARE artifacts: visible in `artifact_list`, served by the web UI,
 *    kept across restarts. Gated as a whole: a script can delete or
 *    overwrite any file in the profile's tree (artifact_delete's gate would
 *    otherwise be bypassed), so each call waits for approval unless
 *    policies.autoApprove lists `bash`.
 * 2. `bash_host` — a privileged shell that runs DIRECTLY on the host
 *    computer running this server. No sandbox, no isolation, the whole
 *    filesystem is reachable. Gated per call: the only list entries for
 *    it are the owner's own, and "Always allow" on its card saves just
 *    that exact script (`bash_host:=<script>`, see auto-approve.ts).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Type } from "typebox";
import { definePlugin, toolCapability, type Plugin } from "../plugin.ts";
import { defineTool, type Tool } from "../tool.ts";
import { DurableFs } from "../fs/durable-fs.ts";
import { workspaceEpoch } from "../fs/workspace-epoch.ts";
import { scopeDir, type HomeScope, type SandboxUser, type ScopeHolder } from "./vault.ts";
import { artifactsDir } from "./artifacts.ts";
import { localShellBackend, type ShellBackend, type ShellExecResult } from "../shell/backend.ts";
import { sandboxNameOf, sandboxShellBackend, scopeHash } from "../shell/sandbox-backend.ts";

const MAX_OUTPUT_CHARS = 20_000;
const HOME = "/home";
const EXEC_TIMEOUT_MS = 180_000;
const HOST_TIMEOUT_MS = 120_000;
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

const present = (result: ShellExecResult) => {
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
        text: parts.length === 0 ? `(exit ${result.exitCode}, no output)` : parts.join("\n"),
      },
    ],
    structuredOutput: { stdout, stderr, exitCode: result.exitCode },
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

interface SandboxSession {
  durable: DurableFs;
  readonly backend: ShellBackend;
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
): Promise<SandboxSession> => {
  const session: SandboxSession = {
    durable: new DurableFs({ dir, conversationId }),
    backend,
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

/** VM → artifact store: upsert changed files, delete removed ones. */
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

const SandboxParams = Type.Object({
  script: Type.String({
    description: "The bash script to run. Files persist in your workspace as artifacts.",
  }),
});

const sandboxTool = (
  dirOf: (conversationId: string) => string,
  backendOf: (
    dir: string,
    conversationId: string,
  ) => Promise<{ readonly backend: ShellBackend; readonly guestRoot: string }>,
  sessions: Map<string, Promise<SandboxSession>>,
): Tool => {
  const open = (dir: string, conversationId: string): Promise<SandboxSession> => {
    const existing = sessions.get(dir);
    if (existing !== undefined) return existing;
    const creating = backendOf(dir, conversationId).then(({ backend, guestRoot }) =>
      openSession(dir, conversationId, backend, guestRoot),
    );
    creating.catch(() => sessions.delete(dir));
    sessions.set(dir, creating);
    return creating;
  };

  return defineTool({
    name: "bash",
    gated: true,
    description:
      `Run a bash script in your own workspace inside your home's microVM ` +
      `(the working directory; on a single-bot install that is the whole VM ` +
      `at ${HOME}). Real Linux in a sandbox: coreutils, pipes, grep, jq, tar, and network ` +
      "access — install packages with apt-get, run python or whatever the task needs. Every " +
      "file you create or change under " +
      HOME +
      " is an artifact: it persists across restarts and the user can see it. The folder " +
      "/home/org-shared is shared with the whole org: never write vault values, tokens or " +
      "credentials there. Working directory " +
      "carries over between calls. Each call waits for your owner's approval (unless they " +
      "chose always-allow): batch work into few scripts, and first say in a sentence what " +
      "the script will change. Never delete or overwrite files you did not create for the " +
      "current task without asking.",
    parameters: SandboxParams,
    structuredOutputSchema: Type.Object({
      stdout: Type.String(),
      stderr: Type.String(),
      exitCode: Type.Number(),
    }),
    execute: async (args, api) => {
      const conversationId = String(api.conversationId);
      const dir = dirOf(conversationId);
      let session: SandboxSession;
      try {
        session = await open(dir, conversationId);
        if (session.epoch !== workspaceEpoch(dir)) await load(session, dir, conversationId);
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
      const cwd = markerCwd(result.stderr);
      if (cwd !== undefined) session.cwd = cwd;
      try {
        await reconcile(session);
      } catch (cause) {
        result = {
          ...result,
          stderr: `${result.stderr}\n[sync] warning: workspace sync to artifacts failed: ${String(cause)}`,
        };
      }
      return present(result);
    },
  });
};

// ---- mode 2: the privileged host shell ----------------------------------

interface HostSession {
  cwd: string;
}

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

const HostParams = Type.Object({
  script: Type.String({ description: "The bash script to run on the host computer." }),
});

const hostTool = (sessions: Map<string, HostSession>): Tool =>
  defineTool({
    name: "bash_host",
    gated: true,
    description:
      "Run a bash script DIRECTLY on the host computer (privileged). No sandbox: the whole " +
      "real filesystem, configuration, and every program on the machine are reachable, and " +
      "changes are permanent. Only use this when the task genuinely needs the host — " +
      "everything else belongs in the sandboxed `bash` tool. Working directory carries over " +
      "between calls. Each call waits for the owner's approval; never ask for this to be " +
      "always-allowed. Prefer the smallest script that does the job, and never touch files " +
      "outside the task's scope.",
    parameters: HostParams,
    structuredOutputSchema: Type.Object({
      stdout: Type.String(),
      stderr: Type.String(),
      exitCode: Type.Number(),
    }),
    execute: async (args, api) => {
      const conversationId = String(api.conversationId);
      let session = sessions.get(conversationId);
      if (session === undefined) {
        session = { cwd: homedir() };
        sessions.set(conversationId, session);
      }
      const result = await runOnHost(args.script, session.cwd, HOST_TIMEOUT_MS);
      const cwd = markerCwd(result.stderr);
      if (cwd !== undefined) session.cwd = cwd;
      return present(result);
    },
  });

/** The bash plugin: the durable workspace in a microVM, plus the host shell. */
export const bashPlugin = (options: BashOptions = {}): Plugin => {
  const root = options.root ?? artifactsDir();
  const holder = options.holder;
  const dirOf = (conversationId: string): string =>
    holder === undefined ? root : scopeDir(holder, conversationId, root);
  // Keyed by SCOPE DIRECTORY, not conversation: one shared tree per profile,
  // so every conversation of a bot sees the same durable files.
  const sessions = new Map<string, Promise<SandboxSession>>();
  const hostSessions = new Map<string, HostSession>();
  const stagingOf = (dir: string): string => join(root, "..", "bash-home", scopeHash(dir));
  // One VM per HOME (org or department) when the mind wires a home-scope
  // resolver: the sandbox is named by the home's scope dir and the bot works
  // in its own folder inside it. Without the resolver, the per-bot VM of
  // older embedders: the bot's dir names the VM and the workspace is /home.
  const backendOf = async (
    dir: string,
    conversationId: string,
  ): Promise<{ readonly backend: ShellBackend; readonly guestRoot: string }> => {
    const home = await holder?.get()?.homeScopeOf?.(conversationId);
    const world = homeWorldOf(dir, home);
    const staging = stagingOf(dir);
    const backend =
      options.backend !== undefined
        ? options.backend(dir, staging, world.guestRoot)
        : sandboxShellBackend({
            name: sandboxNameOf(world.vmDir),
            ...(options.image === undefined ? {} : { image: options.image }),
            guestRoot: world.guestRoot,
            ...(world.sharedGid === undefined ? {} : { sharedGid: world.sharedGid }),
            ...(world.orgShared === undefined ? {} : { orgShared: world.orgShared }),
            ...(world.sharedStore === undefined ? {} : { sharedStore: world.sharedStore }),
            ...(world.deptShared === undefined ? {} : { deptShared: world.deptShared }),
            ...(world.user === undefined ? {} : { user: world.user }),
          })(staging);
    return { backend, guestRoot: world.guestRoot };
  };
  return definePlugin({
    id: "ultiv.bash",
    version: "2.2.0",
    description:
      "Two shells: a sandboxed microVM over the durable workspace (files written here are artifacts), and a privileged shell on the host computer.",
    capabilities: [
      toolCapability(sandboxTool(dirOf, backendOf, sessions)),
      toolCapability(hostTool(hostSessions)),
    ],
  });
};

/** Re-exported for tests and embedders that need the reference backend. */
export { localShellBackend };
