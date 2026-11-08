/**
 * The opt-in REAL-VM browser suite (the CDP driver's chromium): the real
 * driver must boot chromium on a VM whose bot user has NO TMPDIR (the browser
 * path never runs the workspace prepare; chromium aborts at launch when its
 * ProcessSingleton socket dir under TMPDIR is missing) and must leave the
 * bot's home untouched (a hermetic HOME under the profile keeps chromium's
 * dot-dirs out of the workspace). `SPRIESSEN_REAL_VM=1 vp test --run
 * packages/ext/src/shell/real-vm-browser.test.ts` boots one throwaway
 * microsandbox VM (name `spriessen-rvtb-*`) and destroys it afterwards.
 * Never touches a live VM.
 */
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ShellBackend } from "./backend.ts";
import { destroySandbox, sandboxShellBackend } from "./sandbox-backend.ts";
import { driverCallScript } from "../browser/driver.ts";

const REAL = process.env.SPRIESSEN_REAL_VM === "1";
const T = 600_000;
const tag = Math.random().toString(36).slice(2, 8);
const VM = `spriessen-rvtb-${tag}`;
const user = { name: "bot-rvtb", uid: 20_104, gid: 20_104, home: "/home/rvtb" };

const suite = REAL ? describe : describe.skip;

/** One driver command, answered the way the plugin reads it: the last JSON line. */
const drive = async (backend: ShellBackend, op: Record<string, unknown>) => {
  const result = await backend.exec(driverCallScript(JSON.stringify(op)), "/home", 90_000);
  const line = result.stdout
    .split("\n")
    .toReversed()
    .find((candidate) => candidate.startsWith("{"));
  return line === undefined
    ? { ok: false, error: result.stderr.trim().slice(0, 200) }
    : JSON.parse(line);
};

suite(
  `real VM browser driver (${REAL ? "verifying" : "NOT VERIFIED: set SPRIESSEN_REAL_VM=1"})`,
  () => {
    let scratch = "";
    let backend: ShellBackend;
    const previousArtifacts = process.env.ARTIFACTS_DIR;

    beforeAll(async () => {
      const stage = join(homedir(), "workspace", ".ultiv-stage", "tmp");
      mkdirSync(stage, { recursive: true });
      scratch = mkdtempSync(join(stage, "rvtb-"));
      process.env.ARTIFACTS_DIR = join(scratch, "artifacts");
      mkdirSync(process.env.ARTIFACTS_DIR, { recursive: true });
      backend = sandboxShellBackend({ name: VM, guestRoot: user.home, user })(join(scratch, "b"));
      await backend.prepare([]);
    }, T);

    afterAll(async () => {
      await backend
        ?.exec(driverCallScript(JSON.stringify({ op: "close" })), "/home", 30_000)
        .catch(() => {});
      await destroySandbox(VM).catch(() => {});
      if (previousArtifacts === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = previousArtifacts;
      rmSync(scratch, { recursive: true, force: true });
    }, T);

    it(
      "chromium boots with no bot TMPDIR and leaves the bot's home untouched",
      async () => {
        // The field condition (8 Nov 2026): the browser call was the first on a
        // fresh VM, the workspace prepare never ran, and the backend's exec env
        // pointed TMPDIR at the bot's $HOME/.tmp — absent, so chromium aborted
        // with "Failed to create socket directory" before any page opened, and
        // its partial-startup dot-dirs polluted the workspace.
        const before = await backend.exec(
          `rm -rf ${user.home}/.tmp && ls -a ${user.home}`,
          "/home",
          30_000,
        );
        expect(before.stdout).not.toContain(".tmp");
        const opened = await drive(backend, { op: "open", url: "about:blank" });
        expect(opened.ok).toBe(true);
        expect(opened.url).toBe("about:blank");
        const after = await backend.exec(`ls -a ${user.home}`, "/home", 30_000);
        expect(after.stdout).toBe(before.stdout);
      },
      T,
    );
  },
);

it.skipIf(REAL)(
  "real-VM browser suite: NOT VERIFIED in this run (set SPRIESSEN_REAL_VM=1 to run it)",
  () => {
    expect(REAL).toBe(false);
  },
);
