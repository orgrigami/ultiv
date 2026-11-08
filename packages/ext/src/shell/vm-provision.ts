/**
 * The sandbox VM's provisioning pieces (split out of sandbox-backend.ts, no
 * behavior change): the deterministic sandbox name, the bind-path rule, the
 * boot and per-bot provisioning scripts, the exec-option application that
 * runs every bot command as its own Linux user, and the retirement of a
 * removed bot's user (immediate, or marked for the next boot). Leaf module —
 * it imports only types and tiny helpers, never the backend itself; the
 * backend re-exports everything, so consumers are unchanged.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readEnv } from "@spriessen/core";
import type { SandboxUser } from "../plugins/vault.ts";
import type { SharedWrite } from "./backend.ts";
import type { CappedDir } from "./shared-caps.ts";
import { TEAM_SHARED_DIR, teamGroupName } from "./team-shared.ts";
import {
  SETUP_FATAL,
  SETUP_FATAL_CODE,
  SETUP_WARN,
  setfaclStep,
  warnOnFail,
} from "./setup-steps.ts";
import { dnsBridgeBootSteps } from "./dns-bridge.ts";

export { SETUP_FATAL, SETUP_FATAL_CODE, SETUP_WARN, setfaclStep, warnOnFail };
import { clearAppliedFingerprint, type VmSpec } from "./net-policy.ts";
import type { SandboxBackendOptions } from "./sandbox-backend.ts";
import { artifactsDir } from "../plugins/artifacts.ts";

export const HOME = "/home";
export const VM_CPUS = 1;
export const VM_MEMORY_MIB = 512;
export const SHARED_DIR = "/home/shared";
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

/** The hidepid step: remount, then VERIFY — either failing fails the boot. */
export const HIDEPID_SCRIPT = [
  `mount -o remount,hidepid=2 /proc || { echo '${SETUP_FATAL} hidepid remount failed' >&2; exit ${SETUP_FATAL_CODE}; }`,
  `grep -Eq '^proc /proc proc [^ ]*hidepid=(2|invisible)' /proc/mounts || { echo '${SETUP_FATAL} hidepid not in effect' >&2; exit ${SETUP_FATAL_CODE}; }`,
].join("\n");

/**
 * The root boot script: hidepid=2 on /proc, the shared folder, the org-wide
 * folder, and — on an OPEN home only — the in-guest DoH DNS bridge (see
 * shell/dns-bridge.ts: the runtime's gateway resolver is the enforcement on
 * allowlist homes and stays the only resolver there).
 */
export const bootScript = (
  sharedGid: number | undefined,
  orgShared?: { readonly gid: number; readonly readOnly?: boolean },
  netOpen = false,
): string =>
  [
    // Each bot sees only its own processes; a bot cannot undo the remount.
    // No fallback: a VM without hidepid would let bots see each other's
    // processes, so the boot FAILS instead.
    HIDEPID_SCRIPT,
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
          // A team VM mounts it read-only: nothing to set (the org VM
          // owns the store's group and mode).
          ...(orgShared.readOnly === true
            ? []
            : [
                warnOnFail(`chown root:${ORG_GROUP} ${ORG_SHARED_DIR}`, `chown ${ORG_SHARED_DIR}`),
                warnOnFail(`chmod 2775 ${ORG_SHARED_DIR}`, `chmod ${ORG_SHARED_DIR}`),
                setfaclStep(ORG_GROUP, ORG_SHARED_DIR),
              ]),
        ]),
    // The DoH bridge rides along on open homes only (dns-bridge.ts): never
    // where the gateway resolver enforces the allowlist.
    ...(netOpen ? dnsBridgeBootSteps() : []),
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
  teamGids?: readonly number[],
): string =>
  [
    `getent group ${user.gid} >/dev/null 2>&1 || groupadd -g ${user.gid} ${user.name}`,
    `getent passwd ${user.name} >/dev/null 2>&1 || ` +
      `useradd -m -s /bin/bash -u ${user.uid} -g ${user.gid} -d ${user.home} ${user.name}`,
    ...(sharedGid === undefined ? [] : [`usermod -aG ${SHARED_GROUP} ${user.name}`]),
    // Every bot joins the org-wide folder's group, whatever its home (2c).
    ...(orgShared === undefined ? [] : [`usermod -aG ${ORG_GROUP} ${user.name}`]),
    // An ORG bot joins every team's group on its first use of the
    // org VM (slice 2d).
    ...(teamGids ?? []).map((gid) => `usermod -aG ${teamGroupName(gid)} ${user.name}`),
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
  [
    `if id -u ${user.name} >/dev/null 2>&1; then ${warnOnFail(`userdel -r ${user.name}`, `userdel ${user.name}`)}; fi`,
    warnOnFail(`rm -rf ${user.home}`, `rm ${user.home}`),
  ].join("\n");

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
  /** Pipe stdin (the cast's act channel); absent on fake test builders. */
  stdinPipe?(): ExecBuilderShape;
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

// ---- umask 077 vs the shared folders (Phase 4 fix 11) --------------------

/** One shared folder writable in a VM and the numeric gid its files belong to. */
export interface SharedDir {
  readonly dir: string;
  readonly gid: number;
  /** Cross-home folders whose writes are audited (org-shared, team-shared/<id>). */
  readonly audit?: boolean;
}

/**
 * The shared folders a bot can WRITE in this VM, with their group: the
 * home's /home/shared, the org-wide folder when writable (org VM), and each
 * team store under /home/team-shared (org VM). Read-only mounts are
 * left out — nothing written there to fix.
 */
export const writableSharedDirs = (options: SandboxBackendOptions): SharedDir[] => [
  ...(options.sharedGid === undefined ? [] : [{ dir: SHARED_DIR, gid: options.sharedGid }]),
  ...(options.orgShared === undefined || options.orgShared.readOnly
    ? []
    : [{ dir: ORG_SHARED_DIR, gid: options.orgShared.gid, audit: true }]),
  ...(options.teamShared?.teams ?? []).map((d) => ({
    dir: `${TEAM_SHARED_DIR}/${d.id}`,
    gid: d.gid,
    audit: true,
  })),
];

/**
 * The capped writable shared folders of a VM with their host stores (fix
 * 2): org-shared where it is writable, a team VM's own /home/shared
 * (its store), and the org VM's /home/team-shared/<id>. The org VM's own
 * /home/shared lives on the VM disk (no host store) and is bounded by it.
 */
export const cappedDirsOf = (options: SandboxBackendOptions): CappedDir[] => {
  const caps = options.caps;
  if (caps === undefined) return [];
  const out: CappedDir[] = [];
  if (
    options.orgShared !== undefined &&
    !options.orgShared.readOnly &&
    caps.orgShared !== undefined
  ) {
    out.push({
      guest: ORG_SHARED_DIR,
      host: options.orgShared.hostDir,
      capBytes: caps.orgShared,
      label: "org-shared",
    });
  }
  if (options.sharedStore !== undefined && caps.shared !== undefined) {
    out.push({
      guest: SHARED_DIR,
      host: options.sharedStore,
      capBytes: caps.shared,
      label: "team shared",
    });
  }
  for (const d of options.teamShared?.teams ?? []) {
    const cap = caps.team?.[d.id];
    if (cap === undefined || options.teamShared === undefined) continue;
    out.push({
      guest: `${TEAM_SHARED_DIR}/${d.id}`,
      host: join(options.teamShared.parentDir, d.id),
      capBytes: cap,
      label: `team ${d.id} shared`,
    });
  }
  return out;
};

/** The marker of one audited shared write in the normalization output. */
export const SHARED_WRITE_MARK = "spriessen-shared-write";

/** Parses the normalization output into shared-write rows (cross-home folders only). */
export const sharedWritesOf = (stdout: string): SharedWrite[] => {
  const rows: SharedWrite[] = [];
  for (const line of stdout.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3 || parts[0] !== SHARED_WRITE_MARK) continue;
    const bytes = Number(parts[1]);
    const path = parts.slice(2).join("\t");
    if (!Number.isFinite(bytes)) continue;
    if (path === ORG_SHARED_DIR || path.startsWith(`${ORG_SHARED_DIR}/`)) {
      rows.push({ path, bytes, area: "org-shared", teamId: null });
    } else if (path.startsWith(`${TEAM_SHARED_DIR}/`)) {
      const teamId = path.slice(TEAM_SHARED_DIR.length + 1).split("/")[0] ?? "";
      if (teamId !== "") rows.push({ path, bytes, area: "team-shared", teamId });
    }
  }
  return rows;
};

/**
 * The mechanism that makes shared folders work under the bot's umask 077
 * (POSIX default ACLs do not cross a macOS virtiofs mount, so the ACL is
 * not relied on): after every bash call, AS THE BOT (never root — it can
 * only touch what it owns, and following a planted symlink gains nothing),
 * every regular file and directory it owns and changed since the call
 * began (`-newermt`) in a writable shared folder gets the folder's group,
 * group read/write, and — directories — setgid, so the next file inherits
 * the group. Symlinks are never matched (`-type f`/`-type d`, no `-L`).
 */
export const sharedNormalizeScript = (
  uid: number,
  sinceEpochSec: number,
  dirs: readonly SharedDir[],
): string =>
  dirs
    .map(
      ({ dir, gid, audit }) =>
        `if [ -d '${dir}' ]; then ` +
        `find '${dir}' -xdev -user ${uid} -newermt @${sinceEpochSec} -type d ` +
        `-exec chgrp ${gid} {} + -exec chmod g+rwxs {} + ; ` +
        `find '${dir}' -xdev -user ${uid} -newermt @${sinceEpochSec} -type f ` +
        (audit === true ? `-printf '${SHARED_WRITE_MARK}\\t%s\\t%p\\n' ` : "") +
        `-exec chgrp ${gid} {} + -exec chmod g+rw {} + ; fi`,
    )
    .join("\n");

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
 * marked and the backend's boot applies it at the next start. Never throws.
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

/**
 * The create-time spec one VM gets (slice 4): the home's stored size when
 * set, the defaults otherwise, plus the effective allowlist. Pure, so
 * tests assert what reaches the builder without a VM.
 */
export const vmSpecOf = (options: SandboxBackendOptions): VmSpec => ({
  cpus: options.vm?.cpus ?? VM_CPUS,
  memoryMiB: options.vm?.memoryMiB ?? VM_MEMORY_MIB,
  allowlist: options.netAllowlist ?? [],
  open: options.netOpen === true,
  image: options.image ?? sandboxImage(),
  mounts: mountsOf(options),
});

/**
 * The volumes a VM is created with, as stable descriptors (host paths as
 * stored, not resolved — pure). A mount added, dropped or flipped
 * read-only/writable recreates the VM, like a size or allowlist edit.
 */
export const mountsOf = (options: SandboxBackendOptions): string[] => {
  const out: string[] = [];
  if (options.orgShared !== undefined) {
    out.push(
      `${ORG_SHARED_DIR}=${options.orgShared.hostDir}:${options.orgShared.readOnly ? "ro" : "rw"}`,
    );
  }
  if (options.sharedStore !== undefined) out.push(`${SHARED_DIR}=${options.sharedStore}:rw`);
  if (options.teamShared !== undefined) {
    out.push(`${TEAM_SHARED_DIR}=${options.teamShared.parentDir}:rw`);
  }
  return out.sort();
};
