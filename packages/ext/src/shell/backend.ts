/**
 * The shell-backend boundary for the bash faculty: anything that can run a
 * bash script against a POSIX workspace whose root is `/home`. Two live
 * implementations — `sandboxShellBackend` (a microsandbox microVM, the
 * production default) and `localShellBackend` (a real `/bin/bash` child
 * process over a plain host directory, used by tests and as the embedded
 * reference). The workspace contract both sides honor:
 *
 * - `prepare(files)` RESETS the workspace to exactly `files` (the durable
 *   artifact tree is the source of truth; see bash.ts for the sync loop).
 * - `exec` runs a whole script; the workspace persists across execs.
 * - `listFiles`/`readFile` are the read-back half of the sync loop.
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveInside } from "@spriessen/core";

export interface ShellFile {
  /** Workspace path relative to `/home`, POSIX style, no leading slash. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface ShellExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /** Files the bot wrote into a cross-home shared folder during the call. */
  readonly sharedWrites?: readonly SharedWrite[];
}

/** One file written into `/home/org-shared` or `/home/team-shared/<id>`. */
export interface SharedWrite {
  /** Path inside the VM. */
  readonly path: string;
  readonly bytes: number;
  readonly area: "org-shared" | "team-shared";
  /** The team whose store it is; null for org-shared. */
  readonly teamId: string | null;
}

export interface ShellBackend {
  /** Reset the workspace to exactly `files`, ready for exec. */
  prepare(files: readonly ShellFile[]): Promise<void>;
  /**
   * Run a script with the given cwd (absolute, `/home`-rooted). An optional
   * `signal` stops the run: the promise settles with a killed-style result
   * and the script's processes are gone (best effort where the runtime
   * allows). Backends that cannot kill simply run to their timeout.
   */
  exec(
    script: string,
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ShellExecResult>;
  /** Paths of every file in the workspace, relative to `/home`. */
  listFiles(): Promise<readonly string[]>;
  /** Read one workspace file's bytes. */
  readFile(path: string): Promise<Uint8Array>;
  /**
   * True when the workspace this backend prepared is GONE (its VM was
   * recreated, or another session's recreate swapped the VM under it): the
   * caller must `prepare` again before running anything. Optional — a
   * backend that cannot lose its workspace never says so.
   */
  needsPrepare?(): boolean;
  /**
   * Run a script that STAYS alive and talks over its stdio (the browser
   * cast). Undefined when this backend cannot stream: the caller treats the
   * capability as absent, never as an error. The stream ends by itself at
   * `timeoutMs` at the latest.
   */
  stream?(script: string, cwd: string, timeoutMs: number): Promise<ShellStream>;
}

/**
 * A LONG-RUNNING exec whose stdout streams to the caller while it lives and
 * whose stdin the caller can write: the browser cast rides this (screencast
 * frames out, the owner's input acts in). Smaller than `exec` on purpose —
 * there is no result, only the events the stream emits before it dies.
 */
export interface ShellStream {
  /** stdout/stderr chunks as they arrive (bytes, undecoded). */
  readonly onChunk: (listener: (chunk: { stdout: boolean; data: Uint8Array }) => void) => void;
  /** The stream ended (exit, kill or timeout); the reason is already emitted. */
  readonly onExit: (listener: (code: number) => void) => void;
  /** Write to the process's stdin; resolves once handed to the runtime. */
  readonly write: (data: string | Uint8Array) => Promise<void>;
  /** End now: the stdin side closes and the process tree is killed. */
  readonly stop: () => Promise<void>;
}

/**
 * The workspace a backend prepared is gone (a recreated VM): its listing is
 * NOT "the bot deleted everything". The sync loop never deletes artifacts on
 * this error; the next call re-prepares from the artifact store.
 */
export class WorkspaceLostError extends Error {
  override readonly name = "WorkspaceLostError";
}

/** Factory signature plugins use: one backend per workspace scope. */
export type ShellBackendFactory = (homeDir: string, guestRoot?: string) => ShellBackend;

/**
 * A real `/bin/bash` child process over a plain host directory standing in
 * for the workspace root inside the VM (`guestRoot`, default `/home`). With
 * one VM per home the guest root is the bot's own folder (`/home/<bot>`):
 * the `homeDir` then stands in for THAT folder — `prepare` wipes only it,
 * other bots' folders are simply other directories it never touches. Same
 * script, cwd, timeout, and file semantics as the VM — which is exactly why
 * it is a test fixture and never the default.
 */
export const localShellBackend: ShellBackendFactory = (
  homeDir: string,
  guestRoot = "/home",
): ShellBackend => {
  let realHome = existsSync(homeDir) ? realpathSync(homeDir) : "";
  const prefix = guestRoot.endsWith("/") ? guestRoot : `${guestRoot}/`;
  const guestToHost = (value: string): string =>
    value === guestRoot
      ? homeDir
      : resolveInside(
          homeDir,
          value.startsWith(prefix) ? value.slice(prefix.length) : value.replace(/^\/+/, ""),
        );

  const writeAll = (files: readonly ShellFile[]): void => {
    rmSync(homeDir, { recursive: true, force: true });
    mkdirSync(homeDir, { recursive: true });
    realHome = realpathSync(homeDir);
    for (const file of files) {
      const target = resolveInside(homeDir, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.bytes);
    }
  };

  const walk = (dir: string, prefix: string): string[] => {
    const paths: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      // lstat, not stat: like the VM's `find -type f`, only regular files
      // sync back, so a symlink the script made is never followed out of the
      // workspace (readFile below refuses one that points out, too).
      const stat = lstatSync(full);
      if (stat.isDirectory()) paths.push(...walk(full, rel));
      else if (stat.isFile()) paths.push(rel);
    }
    return paths.sort();
  };

  const run = (
    script: string,
    cwd: string,
    timeoutMs: number,
    abortSignal?: AbortSignal,
  ): Promise<ShellExecResult> =>
    new Promise((resolve) => {
      const child = spawn("/bin/bash", ["-c", script], {
        cwd: guestToHost(cwd),
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      });
      let stdout = "";
      let stderr = "";
      const onStop = (): void => {
        child.kill("SIGKILL");
      };
      // A signal that was aborted before this exec started must still kill.
      if (abortSignal !== undefined) {
        if (abortSignal.aborted) onStop();
        else abortSignal.addEventListener("abort", onStop, { once: true });
      }
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      const finish = (exitCode: number): void => {
        // The world we present is /home-rooted: rewrite the exec-boundary
        // marker's physical staging path (realpath'd: /var → /private/var)
        // back to its virtual form before the tool parses it, and virtualize
        // the prefix in stdout so `pwd`-style output matches the VM's world.
        const physical = realHome === "" ? homeDir : realHome;
        const virtualize = (text: string): string =>
          physical === "" ? text : text.split(physical).join(guestRoot);
        stdout = virtualize(stdout);
        stderr = virtualize(stderr);
        resolve({ stdout, stderr, exitCode });
      };
      child.on("error", (cause) => {
        stderr += `\n[bash] ${String(cause)}`;
        finish(127);
      });
      child.on("close", (code, signal) => {
        abortSignal?.removeEventListener("abort", onStop);
        if (signal !== null) {
          stderr += `\n[bash] killed by ${signal} after ${timeoutMs}ms`;
          finish(124);
        } else finish(code ?? 1);
      });
    });

  const startStream = (script: string, cwd: string, timeoutMs: number): ShellStream => {
    const child = spawn("/bin/bash", ["-c", script], {
      cwd: guestToHost(cwd),
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    const chunkers: ((chunk: { stdout: boolean; data: Uint8Array }) => void)[] = [];
    const exiters: ((code: number) => void)[] = [];
    let exited = false;
    const finish = (code: number): void => {
      if (exited) return;
      exited = true;
      for (const exit of exiters) exit(code);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      for (const emit of chunkers) emit({ stdout: true, data: new Uint8Array(chunk) });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      for (const emit of chunkers) emit({ stdout: false, data: new Uint8Array(chunk) });
    });
    child.on("error", () => finish(127));
    child.on("close", (code) => finish(code ?? 1));
    return {
      onChunk: (listener) => chunkers.push(listener),
      onExit: (listener) => exiters.push(listener),
      write: async (data) => {
        if (child.stdin.writable)
          await new Promise<void>((resolve, reject) => {
            child.stdin.write(data, (error) => (error === undefined ? resolve() : reject(error)));
          });
      },
      stop: async () => {
        child.stdin.end();
        child.kill("SIGKILL");
      },
    };
  };

  return {
    prepare: async (files) => {
      writeAll(files);
    },
    exec: (script, cwd, timeoutMs, abortSignal) => run(script, cwd, timeoutMs, abortSignal),
    listFiles: async () => walk(homeDir, ""),
    readFile: async (path) => new Uint8Array(readFileSync(resolveInside(homeDir, path))),
    stream: async (script, cwd, timeoutMs) => startStream(script, cwd, timeoutMs),
  };
};
