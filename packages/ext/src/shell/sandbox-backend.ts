/**
 * The production ShellBackend: a microsandbox microVM per workspace scope.
 * One named sandbox (`ultiv-<hash of the scope dir>`) owns the VM; its
 * workspace root (`guestRoot`, `/home` for a whole-scope VM or the bot's own
 * folder in a shared home VM) holds the durable workspace. `prepare`
 * boots-or-reconnects the VM, wipes ONLY that root, and pushes the artifact
 * tree in over the guest fs channel; `exec` runs `bash -c` inside;
 * `listFiles`/`readFile` pull state back for the sync loop in bash.ts. The
 * VM keeps running between calls (the runtime idle monitor retires it); the
 * sandbox name makes it reattachable across server restarts.
 */
import { createHash } from "node:crypto";
import type { Sandbox } from "microsandbox";
import { readEnv } from "@spriessen/core";
import type { ShellBackend, ShellFile, ShellExecResult } from "./backend.ts";

export interface SandboxBackendOptions {
  /** Deterministic sandbox name for this workspace scope. */
  readonly name: string;
  /** OCI image; default "ubuntu". */
  readonly image?: string;
  /**
   * The workspace root inside the VM (default `/home`). With one VM per home
   * this is the bot's own folder (`/home/<bot>`): `prepare` wipes and refills
   * only it — never another bot's folder, never `/home/shared`.
   */
  readonly guestRoot?: string;
  /**
   * Gid of the home's shared-folder group. When set, the VM's `/home/shared`
   * is provisioned on every boot: root:`ultiv-shared`, mode 2770 (setgid),
   * idempotent. Group MEMBERS (the bots' Linux users) are a later slice.
   */
  readonly sharedGid?: number;
}

const HOME = "/home";
const VM_CPUS = 1;
const VM_MEMORY_MIB = 512;
const SHARED_DIR = "/home/shared";
const SHARED_GROUP = "ultiv-shared";
/**
 * The default VM image: built from `packages/ext/sandbox/Dockerfile`
 * (node 24, python 3 + pip, jq, tar, curl, git on Debian slim) and loaded
 * into the runtime's image store with `msb load`. A registry tag cannot
 * stand in for it, so a fresh machine must build it once; `apt-get` inside
 * the VM is the escape hatch either way.
 */
const DEFAULT_IMAGE = "ultiv-sandbox:latest";

/**
 * The image for new VMs: `SPRIESSEN_SANDBOX_IMAGE` (or the deprecated
 * `ULTIV_SANDBOX_IMAGE`) when set, else the built-in tag. The built-in tag and
 * the VM names keep the old `ultiv-` prefix on purpose: they name an image
 * already loaded on the owner's machine and VMs that hold workspace state.
 */
export const sandboxImage = (): string => {
  const raw = readEnv("SANDBOX_IMAGE")?.trim();
  return raw !== undefined && raw !== "" ? raw : DEFAULT_IMAGE;
};

/** Short stable hash of a scope dir: the identity of its sandbox. */
export const scopeHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 12);

/** The deterministic sandbox name for one workspace scope dir. */
export const sandboxNameOf = (dir: string): string => `ultiv-${scopeHash(dir)}`;

/**
 * Destroy a workspace's microVM by name: stop it first when it is still
 * running (the runtime refuses to remove a running sandbox — purge paths
 * destroy VMs that may be mid-use), then remove it. A missing VM throws;
 * callers catch.
 */
export const destroySandbox = async (name: string): Promise<void> => {
  const { Sandbox } = await import("microsandbox");
  try {
    const handle = await Sandbox.get(name);
    if (handle.status !== "stopped") await handle.stop();
  } catch {
    // Already gone, or the runtime is down: remove below reports it.
  }
  await Sandbox.remove(name);
};

/**
 * Provisions the home's shared folder, once per VM boot, as root: the
 * per-scope group (fixed gid) if missing, then `/home/shared` root-owned,
 * mode 2770 (setgid, so files inside carry the group). Idempotent.
 */
const provisionShared = async (sandbox: Sandbox, gid: number): Promise<void> => {
  const output = await sandbox.execWith("bash", (b) =>
    b
      .args([
        "-c",
        `getent group ${SHARED_GROUP} >/dev/null 2>&1 || groupadd -g ${gid} ${SHARED_GROUP}\n` +
          `mkdir -p ${SHARED_DIR}\n` +
          `chown root:${SHARED_GROUP} ${SHARED_DIR}\n` +
          `chmod 2770 ${SHARED_DIR}`,
      ])
      .cwd(HOME)
      .timeout(30_000),
  );
  if (output.code !== 0) throw new Error(`shared folder provisioning failed: ${output.stderr()}`);
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
        .image(options.image ?? sandboxImage())
        .cpus(VM_CPUS)
        .memory(VM_MEMORY_MIB)
        .workdir(HOME)
        .connectOrCreate();
      if (options.sharedGid !== undefined) await provisionShared(vm, options.sharedGid);
      return vm;
    };

    const root = options.guestRoot ?? HOME;

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
        // The artifact tree is the source of truth: wipe, recreate, refill —
        // the scope's own folder only, so a shared VM keeps every other bot's
        // folder and /home/shared untouched. (The mkdir runs from /home: the
        // folder may not exist yet, and exec needs an existing cwd.)
        await run(`mkdir -p '${root}'`, HOME, 30_000);
        await run(`find '${root}' -mindepth 1 -delete`, root, 30_000);
        const dirs = new Set<string>();
        for (const file of files) {
          const parts = file.path.split("/");
          parts.pop();
          let current = root;
          for (const part of parts) {
            current = `${current}/${part}`;
            dirs.add(current);
          }
        }
        if (dirs.size > 0) {
          await run(`mkdir -p ${[...dirs].map((d) => `'${d}'`).join(" ")}`, root, 30_000);
        }
        const fs = sandbox.fs();
        for (const file of files) await fs.write(`${root}/${file.path}`, file.bytes);
      },

      exec: (script, cwd, timeoutMs) => run(script, cwd, timeoutMs),

      listFiles: async (): Promise<readonly string[]> => {
        const result = await run(
          `cd ${root} && find . -type f -print0 | xargs -0 -n1 printf '%s\\n' | sed 's|^\\./||'`,
          root,
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
        return sandbox.fs().read(`${root}/${path}`);
      },
    };
  };
