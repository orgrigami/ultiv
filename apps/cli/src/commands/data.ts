/**
 * `spriessen data` shows where everything lives; `spriessen data move`
 * moves an install's old data folder (`apps/server/var/`, from before the
 * Spriessen home) into `~/.spriessen/data`.
 *
 * The move refuses while anything could be writing: a server holding the
 * folder's lock, or any process with the database open (a server from
 * before the lock existed; Linux `/proc`, `lsof` elsewhere). It never merges
 * into a home that already has data. Each bot's microVM is named after its
 * folder path, so the moved bots get fresh VMs (rebuilt from their files on
 * first use); the old ones are stopped and removed, best effort.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { dataDir, spriessenHome, usesLegacyData } from "@spriessen/core";
import { stringFlag, type Parsed } from "../args.ts";
import { configDir } from "../config.ts";
import { envFileOf, repoRoot, serverDir } from "./serve.ts";

/** Pids with `file` open (best effort; empty when it cannot tell). */
export const holdersOf = (file: string): number[] => {
  const target = realpathSync(file);
  if (process.platform === "linux") {
    const pids: number[] = [];
    for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
      try {
        const fds = readdirSync(`/proc/${pid}/fd`);
        if (fds.some((fd) => readlinkSync(`/proc/${pid}/fd/${fd}`) === target))
          pids.push(Number(pid));
      } catch {
        // gone, or not ours to read
      }
    }
    return pids;
  }
  try {
    return execFileSync("lsof", ["-t", target], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return []; // lsof exits 1 when nobody has it open
  }
};

/** The microVM names the old server gave its bots: hashes of `var/artifacts/…` as written. */
const oldScopeDirs = (from: string): string[] => {
  const artifacts = join(from, "artifacts");
  if (!existsSync(artifacts)) return [];
  const dirs: string[] = [];
  const children = (path: string): string[] =>
    readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  for (const owner of children(artifacts)) {
    for (const child of children(join(artifacts, owner))) {
      if (child !== "_home") dirs.push(join("var", "artifacts", owner, child));
      else
        for (const home of children(join(artifacts, owner, "_home")))
          dirs.push(join("var", "artifacts", owner, "_home", home));
    }
  }
  return dirs;
};

const retireOldVms = async (dirs: readonly string[]): Promise<number> => {
  if (dirs.length === 0) return 0;
  const { destroySandbox, sandboxNameOf } = await import("@spriessen/ext");
  let removed = 0;
  for (const dir of dirs) {
    const done = destroySandbox(sandboxNameOf(dir)).then(
      () => true,
      () => false,
    );
    const timeout = new Promise<boolean>((resolveTimeout) =>
      setTimeout(() => resolveTimeout(false), 8_000),
    );
    if (await Promise.race([done, timeout])) removed += 1;
  }
  return removed;
};

/** Move every entry of `from` into `to` (a rename, or copy + remove across filesystems). */
const moveEntries = (from: string, to: string): void => {
  mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(from)) {
    if (name === "server.lock") continue;
    try {
      renameSync(join(from, name), join(to, name));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EXDEV") throw cause;
      cpSync(join(from, name), join(to, name), { recursive: true, preserveTimestamps: true });
      rmSync(join(from, name), { recursive: true, force: true });
    }
  }
};

export const dataMove = async (parsed: Parsed): Promise<number> => {
  const from = resolve(stringFlag(parsed, "from") ?? join(serverDir(), "var"));
  const to = resolve(process.env["SPRIESSEN_DATA_DIR"] || join(spriessenHome(), "data"));
  if (!existsSync(join(from, "harness.sqlite"))) {
    console.log(`Nothing to move: ${from} has no Spriessen data. Your data is in ${to}.`);
    return 0;
  }
  if (existsSync(join(to, "harness.sqlite"))) {
    console.error(
      `${to} already has data, so nothing was moved (they would not merge). Move or remove one first.`,
    );
    return 1;
  }
  const { acquireDataLock } = await import("@spriessen/server/data-lock");
  const lock = await acquireDataLock(from, 0); // throws, naming the server, while one runs
  try {
    const open = holdersOf(join(from, "harness.sqlite")).filter((pid) => pid !== process.pid);
    if (open.length > 0) {
      console.error(
        `A server still has the data open (pid ${open.join(", ")}). Stop it, then run this again.`,
      );
      return 1;
    }
    const vms = oldScopeDirs(from);
    moveEntries(from, to);
    console.log(`Moved your data from ${from} to ${to}.`);
    const removed = await retireOldVms(vms);
    if (vms.length > 0)
      console.log(`Bots get fresh microVMs from their files; removed ${removed} old one(s).`);
  } finally {
    lock.release();
  }
  const env = envFileOf(undefined);
  if (env !== undefined && env !== join(spriessenHome(), ".env")) {
    console.log(
      `Your keys are still read from ${env}. To keep them with the data: cp ${env} ${join(spriessenHome(), ".env")}`,
    );
  }
  return 0;
};

export const dataShow = (): number => {
  // A copy of the env: dataDir's one-time warning is for servers; this says it below.
  const env = { ...process.env };
  const legacy = usesLegacyData(env, serverDir());
  const lines: [string, string][] = [
    ["Home", spriessenHome()],
    ["Data", resolve(serverDir(), dataDir(env, serverDir()))],
    ["Keys (.env)", envFileOf(undefined) ?? `none yet (create ${join(spriessenHome(), ".env")})`],
    ["CLI config", configDir()],
    ["Source", repoRoot()],
  ];
  for (const [label, path] of lines) console.log(`${label.padEnd(12)} ${path}`);
  if (legacy)
    console.log(
      "\nThe data is still in the old folder. Stop the server, then run `spriessen data move`.",
    );
  return 0;
};

export const dataCommand = async (parsed: Parsed): Promise<number> => {
  const sub = parsed.positionals[1];
  if (sub === undefined || sub === "show") return dataShow();
  if (sub === "move") return dataMove(parsed);
  console.error("Usage: spriessen data [show | move [--from <dir>]]");
  return 1;
};
