/**
 * Department shared folders in the org VM (phase 4 slice 2d). Each
 * department's durable host store (the SAME directory that backs its own
 * VM's `/home/shared`) is visible in the org VM under
 * `/home/dept-shared/<department id>` — the STORED id, never the name. The
 * org VM mounts the per-org parent directory once; new department stores
 * created beside it appear in the running VM (virtiofs is a live view), so
 * a department create or delete needs NO VM recreation — only
 * `/etc/group` reconciliation, which this module scripts: add missing
 * groups and memberships, remove stale ones, a deleted department's group
 * goes. Ownership is `root:<department group>` mode 2770, the department's
 * stored gid used in BOTH VMs so file groups match. Org bots are read-write
 * (default); the read-only alternative is F-D8.
 */
import type { Sandbox } from "microsandbox";

/** The guest path of the org VM's department shared folders. */
export const DEPT_SHARED_DIR = "/home/dept-shared";

/** The org-VM group for one department's store, named by its stored gid. */
export const deptGroupName = (gid: number): string => `ultiv-d${gid}`;

/** One department's store as the org VM needs to know it. */
export interface DeptStore {
  /** The stored department id (the mountpoint name under /home/dept-shared). */
  readonly id: string;
  /** The department's stored shared-folder gid (same number in both VMs). */
  readonly gid: number;
}

/**
 * Reconcile `/etc/group` in the org VM against the stored departments and
 * org bots: add missing groups, add missing memberships, and delete any
 * `ultiv-d<gid>` group whose department is gone. Idempotent: running it
 * twice changes nothing.
 */
export const deptGroupReconcileScript = (
  depts: readonly DeptStore[],
  users: readonly string[],
): string => {
  const groups = depts.map((d) => deptGroupName(d.gid));
  const add = groups.map(
    (name, i) => `getent group ${name} >/dev/null 2>&1 || groupadd -g ${depts[i]?.gid} ${name}`,
  );
  const members = users.flatMap((user) =>
    groups.map(
      (name) =>
        `id -nG '${user}' 2>/dev/null | tr ' ' '\\n' | grep -qx '${name}' || ` +
        `usermod -aG '${name}' '${user}'`,
    ),
  );
  const stale =
    `known=' ${depts.map((d) => d.gid).join(" ")} '\n` +
    `for row in $(getent group | awk -F: '$1 ~ /^ultiv-d[0-9]+$/ {print $1":"$3}'); do\n` +
    `  name="\${row%%:*}"; gid="\${row##*:}"\n` +
    `  case "$known" in *" $gid "*) ;; *) groupdel "$name" 2>/dev/null || true;; esac\n` +
    `done`;
  return [...add, ...members, stale].join("\n");
};

/**
 * Provision each department store's mountpoint in the org VM: the
 * department's group, mode 2770 (setgid), and a default ACL against the
 * per-bot umask (best effort — POSIX ACLs do not cross a macOS virtiofs
 * mount; docs/SECURITY.md).
 */
export const deptStoreProvisionScript = (depts: readonly DeptStore[]): string =>
  depts
    .flatMap((d) => {
      const dir = `${DEPT_SHARED_DIR}/${d.id}`;
      const group = deptGroupName(d.gid);
      return [
        `mkdir -p '${dir}'`,
        `chown root:${group} '${dir}' 2>/dev/null || true`,
        `chmod 2770 '${dir}' 2>/dev/null || true`,
        `command -v setfacl >/dev/null 2>&1 && ` +
          `setfacl -d -m g:${group}:rwX '${dir}' 2>/dev/null || true`,
      ];
    })
    .join("\n");

/**
 * Run a reconciliation script inside the NAMED org VM when it is running;
 * when it is stopped the next boot reconciles anyway, so this is skipped.
 * Never throws: a down runtime cannot fail a department create or delete.
 */
export const reconcileOrgVm = async (
  name: string,
  script: string,
  io: { readonly exec?: (script: string) => Promise<void> } = {},
): Promise<"reconciled" | "skipped"> => {
  const exec =
    io.exec ??
    (async (run: string) => {
      const { Sandbox: S } = await import("microsandbox");
      const handle = await S.get(name);
      if (handle.status === "stopped") throw new Error("vm is stopped");
      const sandbox: Sandbox = await handle.connect();
      const { applyBotExec } = await import("./sandbox-backend.ts");
      const output = await sandbox.execWith(
        "bash",
        (b) => applyBotExec(b, run, "/home", 30_000, undefined) as never,
      );
      if (output.code !== 0) throw new Error(output.stderr());
    });
  try {
    await exec(script);
    return "reconciled";
  } catch {
    return "skipped";
  }
};
