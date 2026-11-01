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
 * cleared at boot).
 *
 * The provisioning pieces themselves (name, scripts, exec options, user
 * retirement, destroy) live in the leaf module `vm-provision.ts`; everything
 * it exports is re-exported here, so this module stays the one import
 * surface for bash.ts, the purge path, the mind's home scope and the tests.
 */
import type { Sandbox } from "microsandbox";
import type { SandboxUser, SharedCaps } from "../plugins/vault.ts";
import {
  DEPT_SHARED_DIR,
  deptStoreProvisionScript,
  deptGroupReconcileScript,
} from "./dept-shared.ts";
import {
  allowlistNetwork,
  markAppliedFingerprint,
  specDrift,
  vmSpecFingerprint,
} from "./net-policy.ts";
import {
  WorkspaceLostError,
  type ShellBackend,
  type ShellFile,
  type ShellExecResult,
} from "./backend.ts";
import {
  applyBotExec,
  bootScript,
  botProvisionScript,
  destroySandbox,
  HOME,
  orgSharedMount,
  readPendingRemovals,
  resolvedBindPath,
  retireScriptFor,
  sandboxImage,
  SHARED_DIR,
  clearPendingRemovals,
  vmSpecOf,
  SETUP_WARN,
  sharedNormalizeScript,
  sharedWritesOf,
  writableSharedDirs,
  cappedDirsOf,
} from "./vm-provision.ts";
import {
  capMountScript,
  overCapNote,
  overCapRefusal,
  usageUpTo,
  type CappedDir,
} from "./shared-caps.ts";

// Re-exported unchanged: consumers import from here (and `@spriessen/ext`
// re-exports this module), so the split stays invisible.
export {
  applyBotExec,
  bootScript,
  botProvisionScript,
  clearPendingRemovals,
  destroySandbox,
  markPendingRemoval,
  orgSharedMount,
  ORG_GROUP,
  ORG_SHARED_DIR,
  readPendingRemovals,
  resolvedBindPath,
  retireSandboxUser,
  retireScriptFor,
  type RetireOutcome,
  type RetiredUser,
  sandboxImage,
  sandboxNameOf,
  scopeHash,
  SHARED_GROUP,
  type SharedMount,
  type ExecBuilderShape,
  vmSpecOf,
} from "./vm-provision.ts";

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
  /**
   * The home's stored VM size (slice 4): the cpus and memory the VM is
   * CREATED with — the org's or department's stored settings. Undefined
   * reads the defaults (`VM_CPUS` / `VM_MEMORY_MIB`). Create-time-only in
   * the SDK like the policy: an edited size recreates the VM at its next
   * use (the same spec fingerprint).
   */
  readonly vm?: { readonly cpus: number; readonly memoryMiB: number };
  /**
   * Size caps of the writable shared folders (fix 2), in bytes: the org's
   * `/home/org-shared`, a department's own `/home/shared` (its store) and,
   * in the org VM, each `/home/dept-shared/<id>`. Enforced at the tool path
   * (see shell/shared-caps.ts); absent means uncapped.
   */
  readonly caps?: SharedCaps;
}

/**
 * Per VM (by name), bumped on every (re)creation in this process: a backend
 * whose remembered generation differs holds a STALE handle — another bot's
 * session recreated the VM — so it reconnects, provisions its user again
 * and reports `needsPrepare` (its workspace went with the old VM).
 */
const vmGenerations = new Map<string, number>();
export const vmGenerationOf = (name: string): number => vmGenerations.get(name) ?? 0;
const bumpVmGeneration = (name: string): number => {
  const next = vmGenerationOf(name) + 1;
  vmGenerations.set(name, next);
  return next;
};

/** Where a prepared workspace's token lives: root-owned, outside every bot folder. */
const WS_TOKEN_DIR = "/var/lib/spriessen/ws";

/** Logged setup warnings, once per VM and line per process (no log flood). */
const seenWarnings = new Set<string>();

/** Every `SETUP_WARN` line of a provisioning run goes to the server log. */
export const logSetupWarnings = (
  sandboxName: string,
  stderr: string,
  log: (line: string) => void = (line) => console.warn(line),
): void => {
  for (const line of stderr.split("\n")) {
    if (!line.startsWith(SETUP_WARN)) continue;
    const key = `${sandboxName} ${line}`;
    if (seenWarnings.has(key)) continue;
    seenWarnings.add(key);
    log(`[sandbox ${sandboxName}] ${line}`);
  }
};

/** The token file name of one bot folder (`/home/bot-a` -> `home_bot-a`). */
export const tokenNameOf = (root: string): string => root.replace(/^\/+/, "").replaceAll("/", "_");

export const sandboxShellBackend =
  (options: SandboxBackendOptions): ((homeDir: string) => ShellBackend) =>
  (): ShellBackend => {
    let vm: Sandbox | null = null;
    /** The VM generation this backend's handle and user provisioning belong to. */
    let generation = -1;
    /** The token written at the last prepare; null before (or after a lost workspace). */
    let token: string | null = null;
    let lost = false;

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
      // The stored spec IS the VM (slices 3 and 4): size plus policy are
      // create-time-only in the SDK (`modify()` has neither; `restart()`
      // reuses the stored config), so a changed fingerprint recreates the
      // VM — the old one, running or stopped, is removed and a fresh one
      // created FROM THE STORED SIZE AND ALLOWLIST. Running commands die
      // with it (the F-D6 default); the writable layer (installed
      // packages, /etc users) is refilled by the boot provisioning below.
      // This is how a size or allowlist edit "takes effect at the next VM
      // start": the next `ensureVm` after the edit.
      const spec = vmSpecOf(options);
      if (specDrift(options.name, spec)) {
        await destroySandbox(options.name).catch(() => {});
        bumpVmGeneration(options.name);
        vm = null;
      }
      // Another session recreated this VM: the handle is stale and the
      // prepared workspace is gone — reconnect, re-provision, re-prepare.
      if (vm !== null && generation !== vmGenerationOf(options.name)) {
        vm = null;
        if (token !== null) lost = true;
        token = null;
      }
      if (vm !== null) return vm;
      // Dynamic import: the native runtime module loads only when a VM is
      // actually needed, so tests and non-bash paths never touch it.
      const { Sandbox } = await import("microsandbox");
      let builder = Sandbox.builder(options.name)
        .image(options.image ?? sandboxImage())
        .cpus(spec.cpus)
        .memory(spec.memoryMiB)
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
      generation = vmGenerationOf(options.name);
      markAppliedFingerprint(options.name, vmSpecFingerprint(spec));
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
      const stderr = output.stderr();
      logSetupWarnings(options.name, stderr);
      if (output.code !== 0) {
        // Not provisioned is not usable: the next call provisions again
        // (a hidepid failure keeps failing every boot, never runs a command).
        vm = null;
        throw new Error(`VM provisioning failed: ${stderr}`);
      }
      return vm;
    };

    const root = options.guestRoot ?? HOME;
    const user = options.user;

    const sharedDirs = writableSharedDirs(options);
    const capped = cappedDirsOf(options);
    // Applied mount state per capped folder ("ro" | "rw"), valid for one VM
    // generation; unknown at first so the first call converges the VM.
    const capState = new Map<string, "ro" | "rw">();
    let capGeneration = -1;

    /**
     * Measures every capped folder and moves its mount to match (ro over the
     * cap, rw under it). Returns the over-cap folders and whether each is
     * actually read-only now (false: the remount failed — refuse instead).
     */
    const enforceCaps = async (): Promise<{ dir: CappedDir; used: number; ro: boolean }[]> => {
      if (capped.length === 0) return [];
      if (capGeneration !== generation) {
        capState.clear();
        capGeneration = generation;
      }
      const over: { dir: CappedDir; used: number; ro: boolean }[] = [];
      for (const dir of capped) {
        const used = usageUpTo(dir.host, dir.capBytes);
        const want = used > dir.capBytes ? "ro" : "rw";
        let ok = capState.get(dir.guest) === want;
        if (!ok) {
          const applied = await rootRun(
            capMountScript(dir.guest, want === "ro"),
            HOME,
            30_000,
          ).catch(() => ({ stdout: "", stderr: "exec failed", exitCode: 1 }));
          ok = applied.exitCode === 0;
          if (ok) capState.set(dir.guest, want);
          else {
            capState.delete(dir.guest);
            logSetupWarnings(
              options.name,
              `${SETUP_WARN} shared-folder cap remount (${want}) failed for ${dir.guest}`,
            );
          }
        }
        if (want === "ro") over.push({ dir, used, ro: ok });
      }
      return over;
    };

    const run = async (
      script: string,
      cwd: string,
      timeoutMs: number,
    ): Promise<ShellExecResult> => {
      const sandbox = await ensureVm();
      const before = await enforceCaps();
      const unenforced = before.find((row) => !row.ro);
      if (unenforced !== undefined) {
        return { stdout: "", stderr: overCapRefusal(unenforced.dir, unenforced.used), exitCode: 1 };
      }
      // A little slack: the guest clock and mtimes have second granularity.
      const since = Math.floor(Date.now() / 1000) - 2;
      const output = await sandbox.execWith(
        "bash",
        (b) => applyBotExec(b, script, cwd, timeoutMs, user) as never,
      );
      let result: ShellExecResult = {
        stdout: output.stdout(),
        stderr: output.stderr(),
        exitCode: output.code,
      };
      if (user !== undefined && sharedDirs.length > 0) {
        // umask 077 vs the shared folders: hand what the bot just wrote
        // there to the folder's group (as the bot itself — see the script).
        await sandbox
          .execWith(
            "bash",
            (b) =>
              applyBotExec(
                b,
                sharedNormalizeScript(user.uid, since, sharedDirs),
                HOME,
                30_000,
                user,
              ) as never,
          )
          .then((normalized) => {
            const writes = sharedWritesOf(normalized.stdout());
            if (writes.length > 0) result = { ...result, sharedWrites: writes };
            if (normalized.code !== 0) {
              logSetupWarnings(
                options.name,
                `${SETUP_WARN} shared-folder normalization exit ${normalized.code}`,
              );
            }
          })
          .catch(() => {});
      }
      const after = await enforceCaps();
      if (after.length > 0) {
        const notes = after.map((row) => overCapNote(row.dir, row.used, row.ro)).join("\n");
        result = { ...result, stderr: result.stderr === "" ? notes : `${result.stderr}\n${notes}` };
      }
      return result;
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
        const next = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        const tokenFile = `${WS_TOKEN_DIR}/${tokenNameOf(root)}`;
        const wrote = await rootRun(
          `mkdir -p ${WS_TOKEN_DIR} && chmod 700 ${WS_TOKEN_DIR} && printf '%s' '${next}' > '${tokenFile}'`,
          HOME,
          30_000,
        );
        if (wrote.exitCode !== 0) throw new Error(`workspace token write failed: ${wrote.stderr}`);
        token = next;
        lost = false;
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
        // The token first: a VM recreated since `prepare` (by this session
        // or another) has no token — that empty tree is a LOST workspace,
        // never "the bot deleted everything". `.tmp` is the bot's TMPDIR,
        // never an artifact.
        const result = await rootRun(
          `set -o pipefail; printf '%s\\n' "$(cat '${WS_TOKEN_DIR}/${tokenNameOf(root)}' 2>/dev/null)" && ` +
            `cd '${root}' && find . -path ./.tmp -prune -o -type f -print0 | ` +
            `xargs -0 -r -n1 printf '%s\\n' | sed 's|^\\./||'`,
          HOME,
          30_000,
        );
        if (result.exitCode !== 0) {
          throw new Error(`workspace listing failed (exit ${result.exitCode}): ${result.stderr}`);
        }
        const [first = "", ...rest] = result.stdout.split("\n");
        if (lost || token === null || first.trim() !== token) {
          lost = true;
          throw new WorkspaceLostError("the VM workspace was recreated since it was prepared");
        }
        return rest
          .map((line: string) => line.trim())
          .filter((line: string) => line.length > 0)
          .sort();
      },

      needsPrepare: () => lost || (vm !== null && generation !== vmGenerationOf(options.name)),

      readFile: async (path: string): Promise<Uint8Array> => {
        const sandbox = await ensureVm();
        return sandbox.fs().read(`${root}/${path}`);
      },
    };
  };
