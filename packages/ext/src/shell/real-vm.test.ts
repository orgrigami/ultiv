/**
 * Phase 4 fix 10: the opt-in REAL-VM suite. Skipped by default (reported as
 * "not verified"); `SPRIESSEN_REAL_VM=1 vp test --run
 * packages/ext/src/shell/real-vm.test.ts` boots throwaway microsandbox VMs
 * (names `spriessen-rvt-*`, host stores in a temp dir, ARTIFACTS_DIR
 * redirected) and destroys them afterwards. Never touches a live VM.
 *
 * Covers: two bots in one VM cannot read or kill each other; hidepid;
 * /tmp under umask 077; the shared-folder group mechanism; supplementary
 * groups for a numeric uid:gid; org-shared read-only in a team VM;
 * no /home/team-shared there; a new team folder appearing live in
 * the org VM; no network path between VMs; the cap remount; recreate.
 */
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ShellBackend } from "./backend.ts";
import { WorkspaceLostError } from "./backend.ts";
import { destroySandbox, sandboxShellBackend } from "./sandbox-backend.ts";

const REAL = process.env.SPRIESSEN_REAL_VM === "1";
const T = 600_000;
const tag = Math.random().toString(36).slice(2, 8);
const ORG_VM = `spriessen-rvt-org-${tag}`;
const TEAM_VM = `spriessen-rvt-team-${tag}`;

const userA = { name: "bot-rvta", uid: 20_101, gid: 20_101, home: "/home/rvta" };
const userB = { name: "bot-rvtb", uid: 20_102, gid: 20_102, home: "/home/rvtb" };
const userC = { name: "bot-rvtc", uid: 20_103, gid: 20_103, home: "/home/rvtc" };

const suite = REAL ? describe : describe.skip;

suite(`real VM isolation (${REAL ? "verifying" : "NOT VERIFIED: set SPRIESSEN_REAL_VM=1"})`, () => {
  let scratch = "";
  let orgStore = "";
  let teamParent = "";
  let a: ShellBackend;
  let b: ShellBackend;
  let c: ShellBackend;
  const previousArtifacts = process.env.ARTIFACTS_DIR;

  const orgOptions = (user: typeof userA, extra: Record<string, unknown> = {}) => ({
    name: ORG_VM,
    guestRoot: user.home,
    sharedGid: 10_900,
    orgShared: { hostDir: orgStore, gid: 10_901, readOnly: false },
    teamShared: {
      parentDir: teamParent,
      teams: [{ id: "d1", gid: 10_902 }],
      users: [userA.name, userB.name],
    },
    user,
    caps: { orgShared: 1_048_576, team: { d1: 1_073_741_824 } },
    ...extra,
  });

  const sh = async (backend: ShellBackend, script: string, cwd = "/home") =>
    backend.exec(script, cwd, 60_000);

  beforeAll(async () => {
    scratch = mkdtempSync(join(homedir(), "workspace", ".ultiv-stage", "tmp", "rvt-"));
    orgStore = join(scratch, "org-shared");
    teamParent = join(scratch, "team");
    mkdirSync(orgStore, { recursive: true });
    mkdirSync(join(teamParent, "d1"), { recursive: true });
    process.env.ARTIFACTS_DIR = join(scratch, "artifacts");
    mkdirSync(process.env.ARTIFACTS_DIR, { recursive: true });
    a = sandboxShellBackend(orgOptions(userA))(join(scratch, "a"));
    b = sandboxShellBackend(orgOptions(userB))(join(scratch, "b"));
    await a.prepare([{ path: "secret.txt", bytes: new TextEncoder().encode("a-only\n") }]);
    await b.prepare([]);
    c = sandboxShellBackend({
      name: TEAM_VM,
      guestRoot: userC.home,
      sharedGid: 10_902,
      orgShared: { hostDir: orgStore, gid: 10_901, readOnly: true },
      sharedStore: join(teamParent, "d1"),
      user: userC,
      caps: { orgShared: 1_048_576, shared: 1_073_741_824 },
    })(join(scratch, "c"));
    await c.prepare([]);
  }, T);

  afterAll(async () => {
    await destroySandbox(ORG_VM).catch(() => {});
    await destroySandbox(TEAM_VM).catch(() => {});
    if (previousArtifacts === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previousArtifacts;
    rmSync(scratch, { recursive: true, force: true });
  }, T);

  it(
    "bots in one VM cannot read each other's home",
    async () => {
      const own = await sh(a, "cat secret.txt", userA.home);
      expect(own.stdout).toBe("a-only\n");
      const other = await sh(b, `cat ${userA.home}/secret.txt; ls ${userA.home}`);
      expect(other.stdout).toBe("");
      expect(other.exitCode).not.toBe(0);
    },
    T,
  );

  it(
    "hidepid: a bot sees and kills only its own processes",
    async () => {
      const mounts = await sh(a, "grep -E '^proc /proc ' /proc/mounts");
      expect(mounts.stdout).toMatch(/hidepid=(2|invisible)/);
      const started = await sh(a, "nohup sleep 120 >/dev/null 2>&1 & echo $!");
      const pid = started.stdout.trim();
      expect(pid).toMatch(/^\d+$/);
      const seen = await sh(b, `ps -eo pid | grep -qx ' *${pid}' && echo seen || echo hidden`);
      expect(seen.stdout.trim()).toBe("hidden");
      const killed = await sh(b, `kill ${pid} 2>&1; echo rc=$?`);
      expect(killed.stdout).not.toContain("rc=0");
      const alive = await sh(a, `kill -0 ${pid} && echo alive; kill ${pid}`);
      expect(alive.stdout).toContain("alive");
    },
    T,
  );

  it(
    "/tmp files are private under umask 077",
    async () => {
      const made = await sh(a, 'umask; f=$(mktemp /tmp/rvt.XXXX); stat -c %a "$f"; rm -f "$f"');
      expect(made.stdout.split("\n")[0]).toBe("0077");
      expect(made.stdout.split("\n")[1]).toBe("600");
    },
    T,
  );

  it(
    "supplementary groups apply for the numeric uid:gid",
    async () => {
      const ids = await sh(a, "id -G");
      const groups = ids.stdout.trim().split(/\s+/);
      for (const gid of ["20101", "10900", "10901", "10902"]) expect(groups).toContain(gid);
    },
    T,
  );

  it(
    "shared folders work under umask 077 (group handover) and writes are reported",
    async () => {
      const wrote = await sh(
        a,
        "echo hi > /home/org-shared/note.txt; mkdir -p /home/team-shared/d1/sub && echo x > /home/team-shared/d1/sub/f",
      );
      expect(wrote.exitCode).toBe(0);
      expect((wrote.sharedWrites ?? []).map((row) => row.path).sort()).toEqual([
        "/home/team-shared/d1/sub/f",
        "/home/org-shared/note.txt",
      ]);
      const read = await sh(
        b,
        "cat /home/org-shared/note.txt && stat -c '%g %a' /home/org-shared/note.txt && echo more >> /home/team-shared/d1/sub/f && echo ok",
      );
      expect(read.stdout).toContain("hi");
      expect(read.stdout).toContain("10901");
      expect(read.stdout).toContain("ok");
    },
    T,
  );

  it(
    "a new team folder appears live in the org VM",
    async () => {
      mkdirSync(join(teamParent, "d2"));
      const listed = await sh(a, "ls /home/team-shared");
      expect(listed.stdout.split("\n")).toContain("d2");
    },
    T,
  );

  it(
    "team VM: org-shared is read-only, no /home/team-shared, own store is the team's",
    async () => {
      const ro = await sh(
        c,
        "touch /home/org-shared/x 2>&1; echo rc=$?; cat /home/org-shared/note.txt",
      );
      expect(ro.stdout).not.toContain("rc=0");
      expect(ro.stdout).toContain("hi");
      const absent = await sh(c, "test -e /home/team-shared && echo present || echo absent");
      expect(absent.stdout.trim()).toBe("absent");
      const store = await sh(c, "cat /home/shared/sub/f");
      expect(store.stdout).toContain("x");
    },
    T,
  );

  it(
    "no network path between VMs (and offline by default)",
    async () => {
      // A listener in the org VM, proven reachable from inside it; the
      // team VM must not get its answer. (A userspace network stack
      // may accept a TCP connect locally, so only a real answer counts.)
      await sh(
        a,
        "mkdir -p /tmp/rvt-srv && echo RVT-TOKEN > /tmp/rvt-srv/index.html && " +
          "cd /tmp/rvt-srv; nohup python3 -m http.server 8099 </dev/null >/dev/null 2>&1 & sleep 2; echo started",
      );
      const local = await sh(a, "timeout 10 curl -s -m 5 http://127.0.0.1:8099/");
      expect(local.stdout).toContain("RVT-TOKEN");
      const addr = await sh(a, "hostname -I 2>/dev/null | awk '{print $1}'");
      const ip = addr.stdout.trim() === "" ? "10.0.0.1" : addr.stdout.trim();
      const across = await sh(c, `timeout 10 curl -s -m 5 http://${ip}:8099/ ; echo done`);
      expect(across.stdout).not.toContain("RVT-TOKEN");
      const internet = await sh(
        c,
        "timeout 10 curl -s -m 5 https://1.1.1.1/cdn-cgi/trace | grep -c '^fl=' ; echo done",
      );
      expect(internet.stdout.split("\n")[0]).not.toBe("1");
      const dns = await sh(
        c,
        "timeout 10 getent hosts example.com >/dev/null && echo resolved || echo unresolved",
      );
      expect(dns.stdout.trim()).toBe("unresolved");
    },
    T,
  );

  it(
    "over the cap the folder turns read-only, back under it writable again",
    async () => {
      const over = await sh(a, "head -c 2097152 /dev/zero > /home/org-shared/big.bin; echo wrote");
      expect(over.stdout).toContain("wrote");
      expect(over.stderr).toContain("[cap]");
      const blocked = await sh(a, "touch /home/org-shared/more 2>&1; echo rc=$?");
      expect(blocked.stdout + blocked.stderr).toMatch(/rc=[1-9]|over its size cap/);
      rmSync(join(orgStore, "big.bin"));
      const again = await sh(a, "touch /home/org-shared/more && echo ok");
      expect(again.stdout).toContain("ok");
    },
    T,
  );

  it(
    "recreate: an old session's workspace reads as lost, never as empty, and re-prepares",
    async () => {
      // A changed allowlist is spec drift: the next backend recreates the VM.
      const d = sandboxShellBackend(orgOptions(userB, { netAllowlist: ["example.com"] }))(
        join(scratch, "d"),
      );
      await d.prepare([]);
      expect(a.needsPrepare?.()).toBe(true);
      await expect(a.listFiles()).rejects.toBeInstanceOf(WorkspaceLostError);
      await a.prepare([{ path: "secret.txt", bytes: new TextEncoder().encode("back\n") }]);
      const files = await a.listFiles();
      expect(files.map(String).some((name) => name.endsWith("secret.txt"))).toBe(true);
    },
    T,
  );

  it(
    "DNS goes to the host resolver for an allowlisted host",
    async () => {
      const d = sandboxShellBackend(orgOptions(userB, { netAllowlist: ["example.com"] }))(
        join(scratch, "d"),
      );
      const resolved = await sh(
        d,
        "getent hosts example.com >/dev/null && echo resolved || echo failed",
      );
      expect(resolved.stdout.trim()).toBe("resolved");
    },
    T,
  );
});

it.skipIf(REAL)(
  "real-VM suite: NOT VERIFIED in this run (set SPRIESSEN_REAL_VM=1 to run it)",
  () => {
    expect(REAL).toBe(false);
  },
);
