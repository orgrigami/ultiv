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
import { resolveInside } from "@spreissen/core";

export interface ShellFile {
  /** Workspace path relative to `/home`, POSIX style, no leading slash. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface ShellExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface ShellBackend {
  /** Reset the workspace to exactly `files`, ready for exec. */
  prepare(files: readonly ShellFile[]): Promise<void>;
  /** Run a script with the given cwd (absolute, `/home`-rooted). */
  exec(script: string, cwd: string, timeoutMs: number): Promise<ShellExecResult>;
  /** Paths of every file in the workspace, relative to `/home`. */
  listFiles(): Promise<readonly string[]>;
  /** Read one workspace file's bytes. */
  readFile(path: string): Promise<Uint8Array>;
}

/** Factory signature plugins use: one backend per workspace scope. */
export type ShellBackendFactory = (homeDir: string) => ShellBackend;

/**
 * A real `/bin/bash` child process over a plain host directory standing in
 * for `/home`. Same script, cwd, timeout, and file semantics as the VM —
 * which is exactly why it is a test fixture and never the default.
 */
export const localShellBackend: ShellBackendFactory = (homeDir: string): ShellBackend => {
  let realHome = existsSync(homeDir) ? realpathSync(homeDir) : "";
  const guestToHost = (value: string): string =>
    value === "/home"
      ? homeDir
      : resolveInside(homeDir, value.replace(/^\/home\/?/, "").replace(/^\/+/, ""));

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

  const run = (script: string, cwd: string, timeoutMs: number): Promise<ShellExecResult> =>
    new Promise((resolve) => {
      const child = spawn("/bin/bash", ["-c", script], {
        cwd: guestToHost(cwd),
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      });
      let stdout = "";
      let stderr = "";
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
          physical === "" ? text : text.split(physical).join("/home");
        stdout = virtualize(stdout);
        stderr = virtualize(stderr);
        resolve({ stdout, stderr, exitCode });
      };
      child.on("error", (cause) => {
        stderr += `\n[bash] ${String(cause)}`;
        finish(127);
      });
      child.on("close", (code, signal) => {
        if (signal !== null) {
          stderr += `\n[bash] killed by ${signal} after ${timeoutMs}ms`;
          finish(124);
        } else finish(code ?? 1);
      });
    });

  return {
    prepare: async (files) => {
      writeAll(files);
    },
    exec: (script, cwd, timeoutMs) => run(script, cwd, timeoutMs),
    listFiles: async () => walk(homeDir, ""),
    readFile: async (path) => new Uint8Array(readFileSync(resolveInside(homeDir, path))),
  };
};
