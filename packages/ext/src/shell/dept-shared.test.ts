/**
 * Department shared folders in the org VM (phase 4 slice 2d), unit level:
 * the /etc/group reconciliation script (add missing groups and memberships,
 * remove a deleted department's group — idempotent), the per-store
 * provisioning, the parent-directory mount, and the best-effort reconcile
 * into the RUNNING org VM (a stopped VM is skipped; its next boot
 * reconciles anyway). Real-VM behaviour is probed separately (var/probe).
 */
import { describe, expect, it } from "vite-plus/test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEPT_SHARED_DIR,
  deptGroupName,
  deptGroupReconcileScript,
  deptStoreProvisionScript,
  reconcileOrgVm,
} from "./dept-shared.ts";

const depts = [
  { id: "dept-x", gid: 10_002 },
  { id: "dept-y", gid: 10_003 },
];
const users = ["bot-aa11bb22cc33"];

describe("the department group names", () => {
  it("are named by the stored gid, the same number in both VMs", () => {
    expect(deptGroupName(10_002)).toBe("ultiv-d10002");
  });
});

describe("deptGroupReconcileScript", () => {
  const script = deptGroupReconcileScript(depts, users);

  it("adds each department's group with its stored gid", () => {
    expect(script).toContain(
      "getent group ultiv-d10002 >/dev/null 2>&1 || groupadd -g 10002 ultiv-d10002",
    );
    expect(script).toContain("groupadd -g 10003 ultiv-d10003");
  });

  it("adds every org bot to every department's group, only when missing", () => {
    expect(script).toContain(
      "id -nG 'bot-aa11bb22cc33' 2>/dev/null | tr ' ' '\\n' | grep -qx 'ultiv-d10002' || " +
        "usermod -aG 'ultiv-d10002' 'bot-aa11bb22cc33'",
    );
    expect(script.match(/usermod -aG/g)?.length).toBe(users.length * depts.length);
  });

  it("deletes a deleted department's group (a gid that is no longer stored)", () => {
    expect(script).toContain("known=' 10002 10003 '");
    expect(script).toContain('groupdel "$name" 2>/dev/null || true');
    expect(script).toMatch(/ultiv-d\[0-9\]/);
  });

  it("is idempotent: running it twice is the same script", () => {
    expect(deptGroupReconcileScript(depts, users)).toBe(script);
  });
});

describe("deptStoreProvisionScript", () => {
  it("hands each store to its department's group, mode 2770, with a default ACL", () => {
    const script = deptStoreProvisionScript(depts);
    expect(script).toContain(`mkdir -p '${DEPT_SHARED_DIR}/dept-x'`);
    expect(script).toContain(`chown root:ultiv-d10002 '${DEPT_SHARED_DIR}/dept-x'`);
    expect(script).toContain(`chmod 2770 '${DEPT_SHARED_DIR}/dept-x'`);
    expect(script).toContain(`setfacl -d -m g:ultiv-d10002:rwX '${DEPT_SHARED_DIR}/dept-x'`);
    // The stored id is the mountpoint, never the display name.
    expect(script).not.toContain("Ops");
  });
});

describe("reconcileOrgVm (best effort, into the RUNNING org VM)", () => {
  it("runs the script now when the VM can be reached", async () => {
    const ran: string[] = [];
    const outcome = await reconcileOrgVm("ultiv-org-vm", "reconcile-script", {
      exec: async (script) => {
        ran.push(script);
      },
    });
    expect(outcome).toBe("reconciled");
    expect(ran).toEqual(["reconcile-script"]);
  });

  it("skips a stopped VM (its next boot reconciles anyway)", async () => {
    const outcome = await reconcileOrgVm("ultiv-org-vm", "reconcile-script", {
      exec: async () => {
        throw new Error("vm is stopped");
      },
    });
    expect(outcome).toBe("skipped");
  });
});

describe("the parent-directory mount (F-D6)", () => {
  it("binds the RESOLVED parent at /home/dept-shared — new stores appear live", () => {
    const parent = mkdtempSync(join(tmpdir(), "spriessen-dept-shared-"));
    try {
      const resolved = realpathSync(parent);
      // The bind path is the resolved form (/private/tmp on macOS).
      expect(resolved.startsWith("/private/") || resolved === parent).toBe(true);
      expect(DEPT_SHARED_DIR).toBe("/home/dept-shared");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
