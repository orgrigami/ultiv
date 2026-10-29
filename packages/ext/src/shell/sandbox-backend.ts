/**
 * The production ShellBackend: a microsandbox microVM per workspace scope.
 * One named sandbox (`ultiv-<hash of the artifact dir>`) owns the VM; its
 * `/home` is the durable workspace. `prepare` boots-or-reconnects the VM,
 * wipes `/home`, and pushes the artifact tree in over the guest fs channel;
 * `exec` runs `bash -c` inside; `listFiles`/`readFile` pull state back for
 * the sync loop in bash.ts. The VM keeps running between calls (the runtime
 * idle monitor retires it); the sandbox name makes it reattachable across
 * server restarts.
 */
import { createHash } from "node:crypto";
import type { Sandbox } from "microsandbox";
import type { ShellBackend, ShellFile, ShellExecResult } from "./backend.ts";

export interface SandboxBackendOptions {
  /** Deterministic sandbox name for this workspace scope. */
  readonly name: string;
  /** OCI image; default "ubuntu". */
  readonly image?: string;
}

const HOME = "/home";
const VM_CPUS = 1;
const VM_MEMORY_MIB = 512;
/** Debian slim: python3+pip preinstalled, apt-get for everything else. */
const DEFAULT_IMAGE = "python:3.12-slim";

/** Short stable hash of a scope dir: the identity of its sandbox. */
export const scopeHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 12);

/** The deterministic sandbox name for one workspace scope dir. */
export const sandboxNameOf = (dir: string): string => `ultiv-${scopeHash(dir)}`;

/** Destroy a workspace's microVM by name (a missing VM throws; callers catch). */
export const destroySandbox = async (name: string): Promise<void> => {
  const { Sandbox } = await import("microsandbox");
  await Sandbox.remove(name);
};

export const sandboxShellBackend =
  (options: SandboxBackendOptions): ((homeDir: string) => ShellBackend) =>
  (): ShellBackend => {
    let vm: Sandbox | null = null;

    const ensureVm = async (): Promise<Sandbox> => {
      if (vm !== null) return vm;
      // Dynamic import: the native runtime module loads only when a VM is
      // actually needed, so tests and non-bash paths never touch it.
      const { Sandbox } = await import("microsandbox");
      vm = await Sandbox.builder(options.name)
        .image(options.image ?? DEFAULT_IMAGE)
        .cpus(VM_CPUS)
        .memory(VM_MEMORY_MIB)
        .workdir(HOME)
        .connectOrCreate();
      return vm;
    };

    const run = async (
      script: string,
      cwd: string,
      timeoutMs: number,
    ): Promise<ShellExecResult> => {
      const sandbox = await ensureVm();
      const output = await sandbox.execWith("bash", (b) =>
        b.args(["-c", script]).cwd(cwd).timeout(timeoutMs),
      );
      return { stdout: output.stdout(), stderr: output.stderr(), exitCode: output.code };
    };

    return {
      prepare: async (files: readonly ShellFile[]): Promise<void> => {
        const sandbox = await ensureVm();
        // The artifact tree is the source of truth: wipe, recreate, refill.
        await run(`find ${HOME} -mindepth 1 -delete`, HOME, 30_000);
        const dirs = new Set<string>();
        for (const file of files) {
          const parts = file.path.split("/");
          parts.pop();
          let current = HOME;
          for (const part of parts) {
            current = `${current}/${part}`;
            dirs.add(current);
          }
        }
        if (dirs.size > 0) {
          await run(`mkdir -p ${[...dirs].map((d) => `'${d}'`).join(" ")}`, HOME, 30_000);
        }
        const fs = sandbox.fs();
        for (const file of files) await fs.write(`${HOME}/${file.path}`, file.bytes);
      },

      exec: (script, cwd, timeoutMs) => run(script, cwd, timeoutMs),

      listFiles: async (): Promise<readonly string[]> => {
        const result = await run(
          `cd ${HOME} && find . -type f -print0 | xargs -0 -n1 printf '%s\\n' | sed 's|^\\./||'`,
          HOME,
          30_000,
        );
        return result.stdout
          .split("\n")
          .map((line: string) => line.trim())
          .filter((line: string) => line.length > 0)
          .sort();
      },

      readFile: async (path: string): Promise<Uint8Array> => {
        const sandbox = await ensureVm();
        return sandbox.fs().read(`${HOME}/${path}`);
      },
    };
  };
