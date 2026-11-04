/**
 * One server per data folder. Two hosts on one `harness.sqlite` would both
 * resume the same cut turns and both fire every cron job, so a server takes
 * `<data>/server.lock` (its pid, written exclusively) before it opens the
 * mind. A lock whose pid is gone is stale and taken over; a live holder is
 * waited for a little (a `--watch` restart overlaps the old process's
 * shutdown), then refused with a sentence naming it. Tests that open a stack
 * on memory storage never take the lock.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface DataLock {
  readonly path: string;
  readonly release: () => void;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM: the process exists but belongs to someone else.
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
};

const holderOf = (path: string): number | undefined => {
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
};

/** The data folder the server writes into: where HARNESS_DB lives (default `var`). */
export const dataDirOf = (env: NodeJS.ProcessEnv = process.env): string =>
  resolve(dirname(env["HARNESS_DB"] || "var/harness.sqlite"));

const tryTake = (path: string): boolean => {
  try {
    writeFileSync(path, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    const holder = holderOf(path);
    if (holder === process.pid) return true;
    if (holder !== undefined && alive(holder)) return false;
    rmSync(path, { force: true }); // stale: the holder is gone
    return tryTake(path);
  }
};

export const acquireDataLock = async (
  dir: string = dataDirOf(),
  waitMs = 10_000,
): Promise<DataLock> => {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "server.lock");
  const until = Date.now() + waitMs;
  while (!tryTake(path)) {
    if (Date.now() >= until) {
      throw new Error(
        `another Spriessen server (pid ${holderOf(path) ?? "?"}) is using ${dir}; ` +
          "stop it first (two servers on one data folder would run every turn and cron job twice)",
      );
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  return {
    path,
    release: () => {
      if (holderOf(path) === process.pid) rmSync(path, { force: true });
    },
  };
};
