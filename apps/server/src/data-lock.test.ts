/**
 * One server per data folder: the lock is exclusive while its holder lives,
 * a stale lock (its pid gone) is taken over, release only removes our own,
 * and a live holder is refused with a sentence naming it.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { acquireDataLock, dataDirOf } from "./data-lock.ts";

const root = mkdtempSync(join(tmpdir(), "spriessen-lock-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the data-folder lock", () => {
  it("takes the lock with our pid and releases it", async () => {
    const dir = join(root, "a");
    const lock = await acquireDataLock(dir, 0);
    expect(readFileSync(lock.path, "utf8").trim()).toBe(String(process.pid));
    lock.release();
    expect(existsSync(lock.path)).toBe(false);
  });

  it("takes over a stale lock whose holder is gone", async () => {
    const dir = join(root, "b");
    await acquireDataLock(dir, 0).then((lock) => lock.release());
    writeFileSync(join(dir, "server.lock"), "999999999\n");
    const lock = await acquireDataLock(dir, 0);
    expect(readFileSync(lock.path, "utf8").trim()).toBe(String(process.pid));
    lock.release();
  });

  it("refuses while another live process holds it, naming the pid", async () => {
    const dir = join(root, "c");
    const holder = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      await acquireDataLock(dir, 0).then((lock) => lock.release());
      writeFileSync(join(dir, "server.lock"), `${holder.pid}\n`);
      await expect(acquireDataLock(dir, 300)).rejects.toThrow(
        new RegExp(`another Spriessen server \\(pid ${holder.pid}\\)`),
      );
      // Release by someone who does not hold it never removes the holder's lock.
      expect(readFileSync(join(dir, "server.lock"), "utf8").trim()).toBe(String(holder.pid));
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("finds the data folder from HARNESS_DB, default var", () => {
    expect(dataDirOf({})).toMatch(/\/var$/);
    expect(dataDirOf({ HARNESS_DB: "/srv/data/harness.sqlite" })).toBe("/srv/data");
  });
});
