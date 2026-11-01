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
 *
 * Per-bot Linux users (phase 4 slice 2b): when the caller supplies `user`,
 * the VM provisions it idempotently as root on every boot (fixed uid,
 * mode-700 home, membership of the shared-folder group) and remounts `/proc`
 * with `hidepid=2`; `prepare` fills the bot's home as root and hands it to
 * the bot's uid:gid; `exec` runs every bot command AS that user (with
 * `USER`, a per-bot `TMPDIR` and umask 077). Root stays only for setup.
 * A removed bot's user is retired from the VM — immediately when it is
 * running, otherwise marked for the next boot (a pending file, applied and
 * cleared by `ensureVm`).
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Sandbox } from "microsandbox";
import { readEnv } from "@spriessen/core";
import { artifactsDir } from "../plugins/artifacts.ts";
import type { SandboxUser } from "../plugins/vault.ts";
import {
  DEPT_SHARED_DIR,
  deptGroupName,
  deptGroupReconcileScript,
  deptStoreProvisionScript,
} from "./dept-shared.ts";
import {
  allowlistFingerprint,
  allowlistNetwork,
  clearAppliedFingerprint,
  markAppliedFingerprint,
  readAppliedFingerprint,
} from "./net-policy.ts";
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
   * idempotent, and the bot's user joins the group.
   */
  readonly sharedGid?: number;
  /**
   * The org-wide folder (slice 2c): one durable host directory, bind-mounted
   * at `/home/org-shared` into EVERY VM — read-write in the org VM,
   * read-only in a department VM (enforced by the mount). Its group
   * (`ultiv-org`) is the org's own stored gid; every bot's user joins it.
   */
  readonly orgShared?: {
    readonly hostDir: string;
    readonly gid: number;
    readonly readOnly: boolean;
  };
  /**
   * The bot's own Linux user in this VM. When set, every `exec` runs as
   * `uid:gid` (never root) and the user is provisioned idempotently at boot.
   */
  readonly user?: SandboxUser;
  /**
   * The department's own durable store (slice 2d): when set, `/home/shared`
   * is a bind mount of this host directory instead of a writable-layer
   * folder — the same store the org VM sees at
   * `/home/dept-shared/<department id>`.
   */
  readonly sharedStore?: string;
  /**
   * The org VM's department shared folders (slice 2d): the per-org parent
   * directory, bind-mounted at `/home/dept-shared` (its subfolders are the
   * department stores), the stored departments (ids and gids) for
   * provisioning, and every org bot's Linux user for group reconciliation.
   */
  readonly deptShared?: {
    readonly parentDir: string;
    readonly depts: readonly { readonly id: string; readonly gid: number }[];
    readonly users: readonly string[];
  };
  /**
   * The home's network allowlist (slice 3): named hosts the VM may reach.
   * ALWAYS applied — an undefined or empty list boots the VM fully
   * offline (the default). Create-time-only in the SDK: an edited list
   * recreates the VM at its next use (the applied-fingerprint marker).
   */
  readonly netAllowlist?: readonly string[];
}

const HOME = "/home";
const VM_CPUS = 1;
const VM_MEMORY_MIB = 512;
const SHARED_DIR = "/home/shared";
/** The per-scope group every VM's shared folder and its bots' users share. */
export const SHARED_GROUP = "ultiv-shared";
/** The guest path of the org-wide shared folder (slice 2c). */
export const ORG_SHARED_DIR = "/home/org-shared";
/** The org-wide folder's group: the org's own stored gid, every VM. */
export const ORG_GROUP = "ultiv-org";
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
 * The bind path for one host directory: create it when missing, REFUSE a
 * symlinked leaf (the brief's rule), and return the fully resolved path —
 * on macOS `/var/...` reads as `/private/var/...`, which is the only form a
 * bind mount accepts.
 */
export const resolvedBindPath = (hostDir: string): string => {
  let stat;
  try {
    stat = lstatSync(hostDir);
  } catch {
    mkdirSync(hostDir, { recursive: true });
    stat = lstatSync(hostDir);
  }
  if (stat.isSymbolicLink()) throw new Error(`refusing a symlinked bind path: ${hostDir}`);
  return realpathSync(hostDir);
};

/** One declared VM volume: the guest path, the resolved host path, read-only. */
export interface SharedMount {
  readonly guest: string;
  readonly host: string;
  readonly readOnly: boolean;
}

/** The org-wide folder's mount declaration (undefined when not configured). */
export const orgSharedMount = (
  org:
    | {
        readonly hostDir: string;
        readonly gid: number;
        readonly readOnly: boolean;
      }
    | undefined,
  resolveHost: (dir: string) => string = resolvedBindPath,
): SharedMount | undefined =>
  org === undefined
    ? undefined
    : { guest: ORG_SHARED_DIR, host: resolveHost(org.hostDir), readOnly: org.readOnly };

/** The root boot script: hidepid=2 on /proc, the shared folder, the org-wide folder. */
export const bootScript = (
  sharedGid: number | undefined,
  orgShared?: { readonly gid: number },
): string =>
  [
    // Each bot sees only its own processes; a bot cannot undo the remount.
    "mount -o remount,hidepid=2 /proc 2>/dev/null || true",
    ...(sharedGid === undefined
      ? []
      : [
          `getent group ${SHARED_GROUP} >/dev/null 2>&1 || groupadd -g ${sharedGid} ${SHARED_GROUP}`,
          `mkdir -p ${SHARED_DIR}`,
          `chown root:${SHARED_GROUP} ${SHARED_DIR}`,
          `chmod 2770 ${SHARED_DIR}`,
        ]),
    ...(orgShared === undefined
      ? []
      : [
          // The org-wide folder (slice 2c): the mount carries the host
          // store; root sets the group, the mode and a default ACL so
          // files written through the bot's umask 077 stay group-usable.
          `getent group ${ORG_GROUP} >/dev/null 2>&1 || groupadd -g ${orgShared.gid} ${ORG_GROUP}`,
          `mkdir -p ${ORG_SHARED_DIR}`,
          `chown root:${ORG_GROUP} ${ORG_SHARED_DIR} 2>/dev/null || true`,
          `chmod 2775 ${ORG_SHARED_DIR} 2>/dev/null || true`,
          `command -v setfacl >/dev/null 2>&1 && ` +
            `setfacl -d -m g:${ORG_GROUP}:rwX ${ORG_SHARED_DIR} 2>/dev/null || true`,
        ]),
  ].join("\n");

/**
 * The per-bot provisioning, idempotent against the writable layer (check
 * `/etc/passwd` first): fixed uid, own group (falls back to an existing group
 * when the gid is taken — the shared folder's), mode-700 home, and membership
 * of the shared-folder group created at first use, never pre-created.
 */
export const botProvisionScript = (
  user: SandboxUser,
  sharedGid: number | undefined,
  orgShared?: { readonly gid: number },
  deptGids?: readonly number[],
): string =>
  [
    `getent group ${user.gid} >/dev/null 2>&1 || groupadd -g ${user.gid} ${user.name}`,
    `getent passwd ${user.name} >/dev/null 2>&1 || ` +
      `useradd -m -s /bin/bash -u ${user.uid} -g ${user.gid} -d ${user.home} ${user.name}`,
    ...(sharedGid === undefined ? [] : [`usermod -aG ${SHARED_GROUP} ${user.name}`]),
    // Every bot joins the org-wide folder's group, whatever its home (2c).
    ...(orgShared === undefined ? [] : [`usermod -aG ${ORG_GROUP} ${user.name}`]),
    // An ORG bot joins every department's group on its first use of the
    // org VM (slice 2d).
    ...(deptGids ?? []).map((gid) => `usermod -aG ${deptGroupName(gid)} ${user.name}`),
    `mkdir -p ${user.home}`,
    `chown ${user.uid}:${user.gid} ${user.home}`,
    `chmod 700 ${user.home}`,
  ].join("\n");

/**
 * The removal script for a retired bot: delete the user (its membership of
 * every group goes with it) and its home. Guarded so a half-removed state
 * never fails the sweep.
 */
export const retireScriptFor = (user: Pick<SandboxUser, "name" | "home">): string =>
  [`userdel -r ${user.name} 2>/dev/null || true`, `rm -rf ${user.home} 2>/dev/null || true`].join(
    "\n",
  );

/**
 * Applies the bot-user exec options: the command runs as `uid:gid`, with
 * `USER` set (it comes through empty otherwise), a per-bot `TMPDIR` under the
 * bot's home, umask 077, an explicit cwd (it stays `/home` otherwise) and the
 * timeout. Structural so tests can pass a recording fake.
 */
export interface ExecBuilderShape {
  args(args: string[]): ExecBuilderShape;
  cwd(cwd: string): ExecBuilderShape;
  timeout(ms: number): ExecBuilderShape;
  user(user: string): ExecBuilderShape;
  env(key: string, value: string): ExecBuilderShape;
}

export const applyBotExec = <B>(
  builder: B,
  script: string,
  cwd: string,
  timeoutMs: number,
  user: SandboxUser | undefined,
): B => {
  const b = builder as ExecBuilderShape;
  const wrapped = user === undefined ? script : `umask 077; ${script}`;
  b.args(["-c", wrapped]).cwd(cwd).timeout(timeoutMs);
  if (user !== undefined) {
    b.user(`${user.uid}:${user.gid}`).env("USER", user.name).env("TMPDIR", `${user.home}/.tmp`);
  }
  return builder;
};

// ---- retiring a removed bot's user ---------------------------------------

/** A user (and its shared-folder group) to remove from one VM. */
export type RetiredUser = Pick<SandboxUser, "name" | "home">;

/** The pending-removal record for one VM, kept beside the artifact store. */
const pendingPath = (name: string): string =>
  join(artifactsDir(), "..", "sandbox-pending", `${scopeHash(name)}.json`);

/** Pending removals recorded for one VM (empty when none or unreadable). */
export const readPendingRemovals = (name: string, file?: string): RetiredUser[] => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file ?? pendingPath(name), "utf8"));
    return Array.isArray(parsed) ? (parsed as RetiredUser[]) : [];
  } catch {
    return [];
  }
};

/** Records a removal for the next VM boot; dedupes by user name. */
export const markPendingRemoval = (name: string, user: RetiredUser, file?: string): void => {
  const path = file ?? pendingPath(name);
  const rest = readPendingRemovals(name, file).filter((row) => row.name !== user.name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify([...rest, user]));
};

/** Drops one VM's pending-removal file (after applying it, or on destroy). */
export const clearPendingRemovals = (name: string, file?: string): void => {
  rmSync(file ?? pendingPath(name), { force: true });
};

/** Where a removal is applied: "removed" now, or "marked" for the next boot. */
export type RetireOutcome = "removed" | "marked";

/**
 * Retire a removed bot's user from one VM. When the VM can be reached (and
 * `io.exec` is not injected) the script runs now; otherwise the removal is
 * marked and `ensureVm` applies it at the next boot. Never throws.
 */
export const retireSandboxUser = async (
  name: string,
  user: RetiredUser,
  io: { readonly exec?: (script: string) => Promise<void>; readonly file?: string } = {},
): Promise<RetireOutcome> => {
  const exec =
    io.exec ??
    (async (script: string) => {
      const { Sandbox } = await import("microsandbox");
      const handle = await Sandbox.get(name);
      if (handle.status === "stopped") throw new Error("vm is stopped");
      const sandbox = await handle.connect();
      const output = await sandbox.execWith(
        "bash",
        (b) => applyBotExec(b, script, HOME, 30_000, undefined) as never,
      );
      if (output.code !== 0) throw new Error(output.stderr());
    });
  try {
    await exec(retireScriptFor(user));
    return "removed";
  } catch {
    markPendingRemoval(name, user, io.file);
    return "marked";
  }
};

/**
 * Destroy a workspace's microVM by name: stop it first when it is still
 * running (the runtime refuses to remove a running sandbox — purge paths
 * destroy VMs that may be mid-use), then remove it. A missing VM throws;
 * callers catch. Any pending user removals die with the VM.
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
  clearPendingRemovals(name);
  // The applied-policy marker dies with the VM: the next one is created
  // from the current stored allowlist, whatever it is.
  clearAppliedFingerprint(name);
};

export const sandboxShellBackend =
  (options: SandboxBackendOptions): ((homeDir: string) => ShellBackend) =>
  (): ShellBackend => {
    let vm: Sandbox | null = null;

    /** Root steps only: prepare's wipe/refill, the chown handover, listFiles. */
    const rootRun = async (
      script: string,
      cwd: string,
      timeoutMs: number,
    ): Promise<ShellExecResult> => {
      const sandbox = await ensureVm();
      const output = await sandbox.execWith(
        "bash",
        (b) => applyBotExec(b, script, cwd, timeoutMs, undefined) as never,
      );
      return { stdout: output.stdout(), stderr: output.stderr(), exitCode: output.code };
    };

    /** Applies recorded user removals once, then drops the pending file. */
    const applyPending = async (sandbox: Sandbox): Promise<void> => {
      const pending = readPendingRemovals(options.name);
      if (pending.length === 0) return;
      const script = pending.map(retireScriptFor).join("\n");
      const output = await sandbox.execWith(
        "bash",
        (b) => applyBotExec(b, script, HOME, 30_000, undefined) as never,
      );
      if (output.code === 0) clearPendingRemovals(options.name);
    };

    const ensureVm = async (): Promise<Sandbox> => {
      // The stored allowlist IS the policy (slice 3): create-time-only in
      // the SDK (`modify()` has no policy field; `restart()` reuses the
      // stored config), so a changed fingerprint recreates the VM — the
      // old one, running or stopped, is removed and a fresh one created.
      // Running commands die with it (the F-D6 default); the writable
      // layer (installed packages, /etc users) is refilled by the boot
      // provisioning below.
      const fingerprint = allowlistFingerprint(options.netAllowlist ?? []);
      if (readAppliedFingerprint(options.name) !== fingerprint) {
        await destroySandbox(options.name).catch(() => {});
        vm = null;
      }
      if (vm !== null) return vm;
      // Dynamic import: the native runtime module loads only when a VM is
      // actually needed, so tests and non-bash paths never touch it.
      const { Sandbox } = await import("microsandbox");
      let builder = Sandbox.builder(options.name)
        .image(options.image ?? sandboxImage())
        .cpus(VM_CPUS)
        .memory(VM_MEMORY_MIB)
        .workdir(HOME);
      // The org-wide folder (slice 2c): a live bind mount of one durable
      // host directory — a department VM gets it read-only, enforced by the
      // mount, so a department bot's write fails at the mount.
      const orgMount = orgSharedMount(options.orgShared ?? undefined);
      if (orgMount !== undefined) {
        builder = builder.volume(orgMount.guest, (m) => {
          const bound = m.bind(orgMount.host);
          return orgMount.readOnly ? bound.readonly() : bound;
        });
      }
      // The department's own /home/shared is its durable store (slice 2d):
      // the same directory the org VM sees under /home/dept-shared/<id>.
      if (options.sharedStore !== undefined) {
        const host = resolvedBindPath(options.sharedStore);
        builder = builder.volume(SHARED_DIR, (m) => m.bind(host));
      }
      // The org VM's department folders (slice 2d): ONE mount of the parent
      // directory — new stores beside it appear live, so a department
      // create or delete never restarts the VM (F-D6).
      if (options.deptShared !== undefined) {
        const host = resolvedBindPath(options.deptShared.parentDir);
        builder = builder.volume(DEPT_SHARED_DIR, (m) => m.bind(host));
      }
      // The home's network policy (slice 3): deny by default, the stored
      // hosts allowed, TLS relayed untouched (see allowlistNetwork).
      // Applied at creation; see the fingerprint above.
      builder = builder.network((network) => allowlistNetwork(network, options.netAllowlist ?? []));
      vm = await builder.connectOrCreate();
      markAppliedFingerprint(options.name, fingerprint);
      await applyPending(vm);
      const user = options.user;
      const depts = options.deptShared?.depts ?? [];
      const script = [
        bootScript(options.sharedGid, options.orgShared),
        ...(depts.length > 0 ? [deptStoreProvisionScript(depts)] : []),
        ...(depts.length > 0
          ? [deptGroupReconcileScript(depts, options.deptShared?.users ?? [])]
          : []),
        ...(user === undefined
          ? []
          : [
              botProvisionScript(
                user,
                options.sharedGid,
                options.orgShared,
                depts.map((d) => d.gid),
              ),
            ]),
      ].join("\n");
      const output = await vm.execWith(
        "bash",
        (b) => applyBotExec(b, script, HOME, 30_000, undefined) as never,
      );
      if (output.code !== 0) throw new Error(`VM provisioning failed: ${output.stderr()}`);
      return vm;
    };

    const root = options.guestRoot ?? HOME;
    const user = options.user;

    const run = async (
      script: string,
      cwd: string,
      timeoutMs: number,
    ): Promise<ShellExecResult> => {
      const sandbox = await ensureVm();
      const output = await sandbox.execWith(
        "bash",
        (b) => applyBotExec(b, script, cwd, timeoutMs, user) as never,
      );
      return { stdout: output.stdout(), stderr: output.stderr(), exitCode: output.code };
    };

    return {
      prepare: async (files: readonly ShellFile[]): Promise<void> => {
        const sandbox = await ensureVm();
        // The artifact tree is the source of truth: wipe, recreate, refill —
        // the scope's own folder only, so a shared VM keeps every other bot's
        // folder and /home/shared untouched. (The mkdir runs from /home: the
        // folder may not exist yet, and exec needs an existing cwd.) As root,
        // then handed to the bot's uid:gid — mode 700, so only the bot (and
        // root) reaches its files. The chown doubles as the upgrade path:
        // homes that predate per-bot users were root-owned.
        await rootRun(`mkdir -p '${root}'`, HOME, 30_000);
        await rootRun(`find '${root}' -mindepth 1 -delete`, root, 30_000);
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
          await rootRun(`mkdir -p ${[...dirs].map((d) => `'${d}'`).join(" ")}`, root, 30_000);
        }
        const fs = sandbox.fs();
        for (const file of files) await fs.write(`${root}/${file.path}`, file.bytes);
        if (user !== undefined) {
          await rootRun(
            `chown -R ${user.uid}:${user.gid} '${root}'\n` +
              `chmod 700 '${root}'\n` +
              `mkdir -p '${root}/.tmp'\n` +
              `chown ${user.uid}:${user.gid} '${root}/.tmp'`,
            HOME,
            30_000,
          );
        }
      },

      exec: (script, cwd, timeoutMs) => run(script, cwd, timeoutMs),

      listFiles: async (): Promise<readonly string[]> => {
        const result = await rootRun(
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
