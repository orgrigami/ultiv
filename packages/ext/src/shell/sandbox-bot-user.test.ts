/**
 * Per-bot Linux users inside the VM (phase 4 slice 2b), unit level: the
 * command construction the real backend issues — the idempotent root
 * provisioning script (fixed uid, mode-700 home, shared-group membership),
 * the exec options (uid:gid, USER, per-bot TMPDIR, umask 077, explicit cwd),
 * and the retirement of a removed bot's user (immediate, or marked for the
 * next boot). Real-VM behaviour is probed separately (var/probe).
 */
import { afterAll, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync, existsSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeWorldOf } from "../plugins/bash.ts";
import type { HomeScope, SandboxUser } from "../plugins/vault.ts";
import {
  applyBotExec,
  bootScript,
  botProvisionScript,
  orgSharedMount,
  readPendingRemovals,
  retireSandboxUser,
  retireScriptFor,
  type ExecBuilderShape,
  type RetiredUser,
} from "./sandbox-backend.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-sandbox-user-"));

const botA: SandboxUser = {
  name: "bot-aa11bb22cc33",
  uid: 10_000,
  gid: 10_000,
  home: "/home/bot-a",
};

/** A recording fake of the microsandbox exec option builder. */
const fakeBuilder = (): ExecBuilderShape & { calls: [string, ...unknown[]][] } => {
  const calls: [string, ...unknown[]][] = [];
  const shape =
    (method: string) =>
    (...args: unknown[]): ExecBuilderShape => {
      calls.push([method, ...args] as [string, ...unknown[]]);
      return shape2;
    };
  const shape2: ExecBuilderShape = {
    args: shape("args"),
    cwd: shape("cwd"),
    timeout: shape("timeout"),
    user: shape("user"),
    env: shape("env"),
  };
  return { calls, ...shape2 };
};

describe("bootScript (root, per boot)", () => {
  it("remounts /proc with hidepid=2 and FAILS the boot when it cannot (no silent fallback)", () => {
    const script = bootScript(undefined);
    expect(script).toContain("mount -o remount,hidepid=2 /proc || {");
    expect(script).toContain("exit 97");
    // Verified after the remount, not just attempted.
    expect(script).toContain("/proc/mounts");
    expect(script).not.toContain("|| true");
  });

  it("logs every failed chown/chmod/setfacl instead of swallowing it", () => {
    const script = bootScript(10_001, { gid: 10_002 });
    expect(script).not.toContain("|| true");
    expect(script).toContain("|| echo 'spriessen-setup-warn: chown /home/org-shared' >&2");
    expect(script).toContain("|| echo 'spriessen-setup-warn: setfacl /home/org-shared' >&2");
  });

  it("a read-only org mount (team VM) skips the store's chown/chmod", () => {
    const script = bootScript(undefined, { gid: 10_002, readOnly: true });
    expect(script).not.toContain("chown root:ultiv-org");
    expect(script).toContain("groupadd -g 10002 ultiv-org");
  });

  it("provisions the shared folder root-owned, 2770, per-scope group", () => {
    const script = bootScript(10_001);
    expect(script).toContain(
      "getent group ultiv-shared >/dev/null 2>&1 || groupadd -g 10001 ultiv-shared",
    );
    expect(script).toContain("chmod 2770 /home/shared");
  });

  it("provisions the org-wide folder: its own group, 2775, a default ACL against umask 077", () => {
    const script = bootScript(undefined, { gid: 10_001 });
    expect(script).toContain(
      "getent group ultiv-org >/dev/null 2>&1 || groupadd -g 10001 ultiv-org",
    );
    expect(script).toContain("chmod 2775 /home/org-shared");
    expect(script).toContain("setfacl -d -m g:ultiv-org:rwX '/home/org-shared'");
    // Running it twice is the same script: the guards decide.
    expect(bootScript(undefined, { gid: 10_001 })).toBe(script);
  });

  it("an open home (netOpen) boots the DoH DNS bridge, pinned first, never fatal", () => {
    const script = bootScript(undefined, undefined, true);
    expect(script).toContain(".spriessen-dnsd.py");
    expect(script).toContain("dns-query");
    // Pinned FIRST in resolv.conf; a failed pin warns instead of failing the boot.
    expect(script).toContain("sed -i '1i nameserver 127.0.0.1' /etc/resolv.conf");
    expect(script).toContain("|| echo 'spriessen-setup-warn: dns bridge resolv.conf pin' >&2");
    // Running it twice is the same script: the guards decide.
    expect(bootScript(undefined, undefined, true)).toBe(script);
  });

  it("an allowlist home (the default) never installs the bridge", () => {
    expect(bootScript(undefined)).not.toContain("spriessen-dnsd");
    expect(bootScript(10_001, { gid: 10_002 })).not.toContain("dns-query");
  });
});

describe("botProvisionScript (root, idempotent, per bot)", () => {
  it("creates the user only when /etc/passwd lacks it, with the fixed uid", () => {
    const script = botProvisionScript(botA, 10_001);
    expect(script).toContain(
      "getent passwd bot-aa11bb22cc33 >/dev/null 2>&1 || " +
        "useradd -m -s /bin/bash -u 10000 -g 10000 -d /home/bot-a bot-aa11bb22cc33",
    );
    // Running it twice is the same script: nothing but the guards decides.
    expect(botProvisionScript(botA, 10_001)).toBe(script);
  });

  it("adds the bot to the VM's shared group (first use, never pre-created)", () => {
    expect(botProvisionScript(botA, 10_001)).toContain("usermod -aG ultiv-shared bot-aa11bb22cc33");
    expect(botProvisionScript(botA, undefined)).not.toContain("usermod");
  });

  it("adds the bot to the org-wide folder's group in EVERY VM (slice 2c)", () => {
    expect(botProvisionScript(botA, 10_001, { gid: 10_000 })).toContain(
      "usermod -aG ultiv-org bot-aa11bb22cc33",
    );
    // No org-wide folder configured (older embedders): no org group.
    expect(botProvisionScript(botA, 10_001)).not.toContain("ultiv-org");
  });

  it("hands the bot a mode-700 home", () => {
    const script = botProvisionScript(botA, undefined);
    expect(script).toContain("mkdir -p /home/bot-a");
    expect(script).toContain("chown 10000:10000 /home/bot-a");
    expect(script).toContain("chmod 700 /home/bot-a");
  });
});

describe("applyBotExec (every bot command runs as the bot, never root)", () => {
  it("passes uid:gid, USER, a per-bot TMPDIR, umask 077 and an explicit cwd", () => {
    const b = fakeBuilder();
    applyBotExec(b, "id", "/home/bot-a", 5_000, botA);
    expect(b.calls).toEqual([
      ["args", ["-c", "umask 077; id"]],
      ["cwd", "/home/bot-a"],
      ["timeout", 5_000],
      ["user", "10000:10000"],
      ["env", "USER", "bot-aa11bb22cc33"],
      ["env", "TMPDIR", "/home/bot-a/.tmp"],
    ]);
  });

  it("without a user (older embedders) nothing changes: no user, no env, no umask", () => {
    const b = fakeBuilder();
    applyBotExec(b, "id", "/home", 5_000, undefined);
    expect(b.calls.map((row) => row[0])).toEqual(["args", "cwd", "timeout"]);
    expect(b.calls[0]?.[1]).toEqual(["-c", "id"]);
  });
});

describe("retiring a removed bot's user", () => {
  const user: RetiredUser = { name: "bot-aa11bb22cc33", home: "/home/bot-a" };

  it("the script deletes the user — group membership goes with it — and its home", () => {
    const script = retireScriptFor(user);
    expect(script).toContain("userdel -r bot-aa11bb22cc33 2>/dev/null || echo");
    expect(script).toContain("rm -rf /home/bot-a 2>/dev/null || echo");
    expect(script).not.toContain("|| true");
  });

  it("runs now when the VM can be reached", async () => {
    const ran: string[] = [];
    const outcome = await retireSandboxUser("ultiv-x", user, {
      exec: async (script) => {
        ran.push(script);
      },
    });
    expect(outcome).toBe("removed");
    expect(ran).toEqual([retireScriptFor(user)]);
  });

  it("marks the removal for the next boot when the VM cannot be reached", async () => {
    const file = join(scratch, "pending", "ultiv-x.json");
    const outcome = await retireSandboxUser("ultiv-x", user, {
      exec: async () => {
        throw new Error("runtime down");
      },
      file,
    });
    expect(outcome).toBe("marked");
    expect(readPendingRemovals("ultiv-x", file)).toEqual([user]);
    // A second removal of the same bot does not double the record.
    await retireSandboxUser("ultiv-x", user, {
      exec: async () => {
        throw new Error("runtime down");
      },
      file,
    });
    expect(readPendingRemovals("ultiv-x", file)).toEqual([user]);
    expect(existsSync(file)).toBe(true);
    rmSync(file, { force: true });
  });
});

describe("homeWorldOf carries the bot's user to the VM backend", () => {
  it("the scope's user rides along with the VM name and guest root", () => {
    const home: HomeScope = { dir: "/h/_home/org", sharedGid: 10_000, user: botA };
    const world = homeWorldOf("/h/owner-a/bot-a", home);
    expect(world.user).toEqual(botA);
    expect(world.guestRoot).toBe("/home/bot-a");
    expect(homeWorldOf("/h/owner-a/bot-a", { dir: "/h/_home/org" }).user).toBeUndefined();
  });

  it("the org-wide folder rides along with its store, gid and read-only flag (2c)", () => {
    const orgShared = { hostDir: "/h/_shared/org", gid: 10_001, readOnly: true };
    const world = homeWorldOf("/h/owner-a/bot-a", {
      dir: "/h/_home/team-x",
      sharedGid: 10_002,
      orgShared,
    });
    expect(world.orgShared).toEqual(orgShared);
    expect(homeWorldOf("/h/owner-a/bot-a", { dir: "/h/_home/org" }).orgShared).toBeUndefined();
  });
});

describe("the org-wide folder's mount (slice 2c)", () => {
  it("binds the RESOLVED host path at /home/org-shared, read-only as asked", () => {
    const dir = join(scratch, "store-org");
    const mount = orgSharedMount({ hostDir: dir, gid: 10_001, readOnly: false });
    expect(mount).toEqual({ guest: "/home/org-shared", host: realpathSync(dir), readOnly: false });
    const ro = orgSharedMount({ hostDir: dir, gid: 10_001, readOnly: true });
    expect(ro?.readOnly).toBe(true);
  });

  it("creates the store when missing and refuses a symlinked path", () => {
    const fresh = join(scratch, "made", "now");
    const mount = orgSharedMount({ hostDir: fresh, gid: 10_001, readOnly: false });
    expect(existsSync(fresh)).toBe(true);
    expect(mount?.host).toBe(realpathSync(fresh));
    const link = join(scratch, "link-store");
    symlinkSync(fresh, link);
    expect(() => orgSharedMount({ hostDir: link, gid: 10_001, readOnly: false })).toThrow(
      /symlinked bind path/,
    );
  });

  it("is absent when the embedder configures no org-wide folder", () => {
    expect(orgSharedMount(undefined)).toBeUndefined();
  });
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("setup warnings reach the log", () => {
  it("logs each SETUP_WARN line once per VM, ignores other stderr", async () => {
    const { logSetupWarnings } = await import("./sandbox-backend.ts");
    const lines: string[] = [];
    const stderr = "noise\nspriessen-setup-warn: chown /home/x\n";
    logSetupWarnings("ultiv-log-test", stderr, (line) => lines.push(line));
    logSetupWarnings("ultiv-log-test", stderr, (line) => lines.push(line));
    expect(lines).toEqual(["[sandbox ultiv-log-test] spriessen-setup-warn: chown /home/x"]);
  });
});
