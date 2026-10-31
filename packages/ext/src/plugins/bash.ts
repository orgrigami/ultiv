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
 *    filesystem is reachable. Gated per call, always: never list
 *    `bash_host` in policies.autoApprove.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { definePlugin, toolCapability, type Plugin } from "../plugin.ts";
import { defineTool, type Tool } from "../tool.ts";
import { DurableFs } from "../fs/durable-fs.ts";
import { scopeDir, type ScopeHolder } from "./vault.ts";
import { artifactsDir } from "./artifacts.ts";
import { localShellBackend, type ShellBackend, type ShellExecResult } from "../shell/backend.ts";
import { sandboxNameOf, sandboxShellBackend, scopeHash } from "../shell/sandbox-backend.ts";

const MAX_OUTPUT_CHARS = 20_000;
const HOME = "/home";
const EXEC_TIMEOUT_MS = 180_000;
const HOST_TIMEOUT_MS = 120_000;
const CWD_MARKER = "__SPREISSEN_CWD__";

export interface BashOptions {
  /** Workspace root; default ARTIFACTS_DIR. */
  readonly root?: string;
  /** Profile-scope resolver; when set, each conversation works in its profile's tree. */
  readonly holder?: ScopeHolder;
  /** OCI image for the microVM; default `ultiv-sandbox:latest`, `SPREISSEN_SANDBOX_IMAGE` overrides. */
  readonly image?: string;
  /**
   * Backend factory override, keyed by the scope's absolute workspace dir.
   * Tests inject `localShellBackend`; production defaults to the microsandbox
   * microVM (`sandboxShellBackend`). `homeDir` is the plain host directory
   * standing in for /home (the local backend's staging dir).
   */
  readonly backend?: (dir: string, homeDir: string) => ShellBackend;
}

/** Appends an exit-code-preserving exec-boundary marker that reports $PWD. */
const wrapScript = (script: string): string =>
  `${script}\n__spreissen_rc=$?; echo "${CWD_MARKER}$PWD" 1>&2; exit $__spreissen_rc`;

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
  readonly durable: DurableFs;
  readonly backend: ShellBackend;
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
): Promise<SandboxSession> => {
  const durable = new DurableFs({ dir, conversationId });
  const files = [];
  const hashes = new Map<string, string>();
  for (const path of durable.allFilePaths()) {
    const bytes = await durable.readFileBuffer(path);
    const rel = path.slice(1); // "/a/b" -> "a/b"
    files.push({ path: rel, bytes });
    hashes.set(rel, sha256(bytes));
  }
  await backend.prepare(files);
  return { durable, backend, hashes, cwd: HOME };
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
  backendOf: (dir: string) => ShellBackend,
  sessions: Map<string, Promise<SandboxSession>>,
): Tool => {
  const open = (dir: string, conversationId: string): Promise<SandboxSession> => {
    const existing = sessions.get(dir);
    if (existing !== undefined) return existing;
    const creating = openSession(dir, conversationId, backendOf(dir));
    sessions.set(dir, creating);
    return creating;
  };

  return defineTool({
    name: "bash",
    gated: true,
    description:
      `Run a bash script in your own microVM workspace, mounted at ${HOME} (the working ` +
      "directory). Real Linux in a sandbox: coreutils, pipes, grep, jq, tar, and network " +
      "access — install packages with apt-get, run python or whatever the task needs. Every " +
      "file you create or change under " +
      HOME +
      " is an artifact: it persists across restarts and the user can see it. Working directory " +
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
  const backendOf = (dir: string): ShellBackend =>
    options.backend !== undefined
      ? options.backend(dir, stagingOf(dir))
      : sandboxShellBackend({
          name: sandboxNameOf(dir),
          ...(options.image === undefined ? {} : { image: options.image }),
        })(stagingOf(dir));
  return definePlugin({
    id: "ultiv.bash",
    version: "2.0.0",
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
