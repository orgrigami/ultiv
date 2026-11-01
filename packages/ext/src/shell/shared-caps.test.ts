/**
 * Fix 2: shared-folder caps at the tool path, and the shared-write audit
 * rows. The remount itself only runs in a real VM (opt-in suite); here the
 * pure pieces: which folders are capped, the measurement, the mount
 * scripts, the refusal text and the audit parsing — plus the bash plugin
 * forwarding writes to the resolver and keeping them out of the output.
 */
import { afterAll, describe, expect, it } from "vite-plus/test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capMountScript, overCapNote, overCapRefusal, usageUpTo } from "./shared-caps.ts";
import {
  cappedDirsOf,
  SHARED_WRITE_MARK,
  sharedNormalizeScript,
  sharedWritesOf,
} from "./vm-provision.ts";
import { bashPlugin, localShellBackend } from "../plugins/bash.ts";
import { createScopeHolder } from "../plugins/vault.ts";
import type { SharedWrite } from "./backend.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-caps-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("cappedDirsOf", () => {
  it("org VM: org-shared and every department store, never its own on-disk /home/shared", () => {
    const dirs = cappedDirsOf({
      name: "v",
      sharedGid: 10_000,
      orgShared: { hostDir: "/s/org", gid: 10_001, readOnly: false },
      deptShared: { parentDir: "/s/dept", depts: [{ id: "research", gid: 10_002 }], users: [] },
      caps: { orgShared: 1024, dept: { research: 2048 } },
    });
    expect(dirs.map((d) => [d.guest, d.host, d.capBytes])).toEqual([
      ["/home/org-shared", "/s/org", 1024],
      ["/home/dept-shared/research", "/s/dept/research", 2048],
    ]);
  });

  it("dept VM: its own store only (org-shared is read-only there)", () => {
    const dirs = cappedDirsOf({
      name: "v",
      orgShared: { hostDir: "/s/org", gid: 10_001, readOnly: true },
      sharedStore: "/s/dept/research",
      caps: { orgShared: 1024, shared: 4096 },
    });
    expect(dirs.map((d) => d.guest)).toEqual(["/home/shared"]);
  });

  it("no caps, nothing capped", () => {
    expect(
      cappedDirsOf({ name: "v", orgShared: { hostDir: "/s", gid: 1, readOnly: false } }),
    ).toEqual([]);
  });
});

describe("usageUpTo", () => {
  it("sums regular files, never follows a symlink, stops past the limit", () => {
    const dir = join(scratch, "usage");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "a"), Buffer.alloc(100));
    writeFileSync(join(dir, "sub", "b"), Buffer.alloc(50));
    const outside = join(scratch, "big");
    writeFileSync(outside, Buffer.alloc(10_000));
    symlinkSync(outside, join(dir, "link"));
    expect(usageUpTo(dir, 1_000_000)).toBe(150);
    expect(usageUpTo(dir, 120)).toBeGreaterThan(120);
    expect(usageUpTo(join(scratch, "missing"), 10)).toBe(0);
  });
});

describe("capMountScript", () => {
  it("read-only: a bind onto itself, remounted ro, verified; idempotent", () => {
    const script = capMountScript("/home/org-shared", true);
    expect(script).toContain("mount --bind '/home/org-shared' '/home/org-shared'");
    expect(script).toContain("mount -o remount,bind,ro '/home/org-shared'");
    expect(script).toContain("findmnt -no OPTIONS --mountpoint '/home/org-shared'");
  });

  it("read-write: pops the ro layers only, bounded", () => {
    const script = capMountScript("/home/shared", false);
    expect(script).toContain("umount '/home/shared'");
    expect(script).not.toContain("mount --bind");
    expect(script).toContain("-lt 8");
  });

  it("says what is blocked and what to do", () => {
    const dir = { guest: "/home/org-shared", host: "/s", capBytes: 1_048_576, label: "org-shared" };
    expect(overCapNote(dir, 2_097_152, true)).toContain("read-only");
    expect(overCapRefusal(dir, 2_097_152)).toContain("raise its cap");
  });
});

describe("shared-write audit rows", () => {
  it("normalization prints a row per file in cross-home folders only", () => {
    const script = sharedNormalizeScript(20_001, 1, [
      { dir: "/home/shared", gid: 10_000 },
      { dir: "/home/org-shared", gid: 10_001, audit: true },
    ]);
    const [own, org] = script.split("\n");
    expect(own).not.toContain(SHARED_WRITE_MARK);
    expect(org).toContain(`-printf '${SHARED_WRITE_MARK}`);
  });

  it("parses rows with area and department, ignoring anything else", () => {
    const out = [
      `${SHARED_WRITE_MARK}\t12\t/home/org-shared/plan.md`,
      `${SHARED_WRITE_MARK}\t7\t/home/dept-shared/research/notes/a.txt`,
      `${SHARED_WRITE_MARK}\t5\t/home/shared/x`,
      "noise",
    ].join("\n");
    expect(sharedWritesOf(out)).toEqual([
      { path: "/home/org-shared/plan.md", bytes: 12, area: "org-shared", departmentId: null },
      {
        path: "/home/dept-shared/research/notes/a.txt",
        bytes: 7,
        area: "dept-shared",
        departmentId: "research",
      },
    ]);
  });

  it("the bash tool hands writes to the resolver and keeps them out of its output", async () => {
    const seen: { conversationId: string; rows: readonly SharedWrite[] }[] = [];
    const holder = createScopeHolder();
    holder.set({
      scopeOf: () => ({ owner: "o", profile: "b" }),
      sharedWrite: (conversationId, rows) => seen.push({ conversationId, rows }),
    });
    const row: SharedWrite = {
      path: "/home/org-shared/a",
      bytes: 3,
      area: "org-shared",
      departmentId: null,
    };
    const plugin = bashPlugin({
      root: join(scratch, "tool"),
      holder,
      backend: (_dir, _staging, guestRoot) => {
        const inner = localShellBackend(join(scratch, "tool-disk"), guestRoot);
        return {
          ...inner,
          exec: async (script, cwd, timeout) => ({
            ...(await inner.exec(script, cwd, timeout)),
            sharedWrites: [row],
          }),
        };
      },
    });
    const capability = plugin.capabilities.find((c) => c.kind === "tool" && c.tool.name === "bash");
    if (capability?.kind !== "tool") throw new Error("missing bash tool");
    const ran = await capability.tool.execute(
      { script: "true" },
      { conversationId: "conv-9" } as never,
      {} as never,
    );
    expect(seen).toEqual([{ conversationId: "conv-9", rows: [row] }]);
    expect(JSON.stringify(ran.structuredOutput)).not.toContain("sharedWrites");
  });
});
