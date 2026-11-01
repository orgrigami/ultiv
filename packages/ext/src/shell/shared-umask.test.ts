/**
 * Phase 4 fix 11: umask 077 vs the shared folders. Not the ACL (it does not
 * cross a macOS virtiofs mount): after each bash call the bot's OWN new or
 * changed files in a writable shared folder get the folder's group, g+rw,
 * and setgid on directories — run as the bot, symlinks never matched.
 * Script shape here; real behaviour in the opt-in real-VM suite. The local
 * part runs the same find/chmod logic on the host to prove the effect.
 */
import { afterAll, describe, expect, it } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { sharedNormalizeScript, writableSharedDirs } from "./vm-provision.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-umask-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("writableSharedDirs", () => {
  it("dept VM: /home/shared only (org-shared is read-only there)", () => {
    expect(
      writableSharedDirs({
        name: "v",
        sharedGid: 10_005,
        orgShared: { hostDir: "/s", gid: 10_001, readOnly: true },
      }),
    ).toEqual([{ dir: "/home/shared", gid: 10_005 }]);
  });

  it("org VM: its /home/shared, the org-wide folder and every department store", () => {
    expect(
      writableSharedDirs({
        name: "v",
        sharedGid: 10_002,
        orgShared: { hostDir: "/s", gid: 10_001, readOnly: false },
        deptShared: { parentDir: "/d", depts: [{ id: "research", gid: 10_007 }], users: [] },
      } as never),
    ).toEqual([
      { dir: "/home/shared", gid: 10_002 },
      { dir: "/home/org-shared", gid: 10_001 },
      { dir: "/home/dept-shared/research", gid: 10_007 },
    ]);
  });
});

describe("sharedNormalizeScript", () => {
  const script = sharedNormalizeScript(20_001, 1_700_000_000, [{ dir: "/home/shared", gid: 10_005 }]);

  it("touches only the bot's own files changed since the call began, never symlinks", () => {
    expect(script).toContain("-user 20001");
    expect(script).toContain("-newermt @1700000000");
    expect(script).toContain("-type f");
    expect(script).toContain("-type d");
    expect(script).not.toContain(" -L ");
    expect(script).toContain("chmod g+rwxs");
    expect(script).toContain("chgrp 10005");
  });

  it("really makes umask-077 files group read/write (host run, GNU find only)", () => {
    const hasGnuFind = (() => {
      try {
        execFileSync("find", ["/", "-maxdepth", "0", "-newermt", "@0"], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    })();
    if (!hasGnuFind) return; // BSD find lacks -newermt @epoch; the VM has GNU find
    const dir = join(scratch, "shared");
    mkdirSync(join(dir, "sub"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "sub", "f.txt"), "x", { mode: 0o600 });
    symlinkSync("/etc/hosts", join(dir, "link"));
    const { uid, gid } = userInfo();
    execFileSync("bash", [
      "-c",
      sharedNormalizeScript(uid, Math.floor(Date.now() / 1000) - 5, [{ dir, gid }]),
    ]);
    expect(statSync(join(dir, "sub", "f.txt")).mode & 0o060).toBe(0o060);
    expect(statSync(join(dir, "sub")).mode & 0o2070).toBe(0o2070);
  });
});
