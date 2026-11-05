/**
 * `spriessen update [--check]`: bring this install up to date from its git
 * checkout. Fetches, then only fast-forwards — it never merges, rebases or
 * touches local edits: a checkout with changes to tracked files, a detached
 * HEAD, no upstream, or local commits the upstream lacks is left alone with
 * a sentence saying why. After the pull it re-runs scripts/install-cli.sh
 * (the NEW one, so install changes ship too) into the folder this launcher
 * lives in, and restarts each installed daemon (server, node) so they run
 * the new code. `--check` stops after saying what is new.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { boolFlag, type Parsed } from "../args.ts";
import type { DaemonRole } from "../daemon/units.ts";
import { control, unitPath } from "./daemon.ts";
import { repoRoot } from "./serve.ts";

/** Runs one command in the checkout; answers its trimmed stdout, or undefined when it failed. */
export type Run = (command: string, args: readonly string[]) => string | undefined;

const realRun =
  (cwd: string): Run =>
  (command, args) => {
    const result = spawnSync(command, args, { cwd, encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : undefined;
  };

export type Plan =
  | { readonly kind: "blocked"; readonly why: string }
  | { readonly kind: "current"; readonly branch: string }
  | {
      readonly kind: "behind";
      readonly branch: string;
      readonly upstream: string;
      readonly commits: readonly string[];
    };

/** What an update would do, from git alone (fetches first unless told not to). */
export const planUpdate = (git: Run, fetch = true): Plan => {
  if (git("git", ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    return {
      kind: "blocked",
      why: "This install isn't a git checkout, so it can't update itself.",
    };
  }
  const branch = git("git", ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch === undefined) {
    return {
      kind: "blocked",
      why: "The checkout isn't on a branch (detached HEAD). Check out a branch first.",
    };
  }
  const upstream = git("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (upstream === undefined) {
    return {
      kind: "blocked",
      why: `The branch ${branch} doesn't track a remote branch, so there's nothing to pull.`,
    };
  }
  if ((git("git", ["status", "--porcelain", "--untracked-files=no"]) ?? "x") !== "") {
    return {
      kind: "blocked",
      why: "The checkout has uncommitted changes. Commit or stash them, then run `spriessen update` again.",
    };
  }
  if (fetch && git("git", ["fetch", "--quiet"]) === undefined) {
    return {
      kind: "blocked",
      why: `Couldn't fetch from ${upstream.split("/")[0]}. Check your network and access, then try again.`,
    };
  }
  const ahead = Number(git("git", ["rev-list", "--count", "@{u}..HEAD"]) ?? "0");
  if (ahead > 0) {
    return {
      kind: "blocked",
      why: `${branch} has ${ahead} local commit(s) ${upstream} doesn't have. Push or rebase them yourself; update only fast-forwards.`,
    };
  }
  const log = git("git", ["log", "--oneline", "--no-decorate", "HEAD..@{u}"]) ?? "";
  const commits = log === "" ? [] : log.split("\n");
  return commits.length === 0
    ? { kind: "current", branch }
    : { kind: "behind", branch, upstream, commits };
};

/** Where this command's launcher lives (the folder install-cli.sh wrote it to). */
const launcherDir = (): string => {
  const launcher = process.env["SPRIESSEN_LAUNCHER"];
  return launcher !== undefined && launcher !== ""
    ? dirname(launcher)
    : join(homedir(), ".local", "bin");
};

const installedDaemons = (): DaemonRole[] =>
  (["server", "node"] as const).filter((role) => existsSync(unitPath(role)));

const show = (plan: Extract<Plan, { kind: "behind" }>): void => {
  console.log(`${plan.commits.length} new commit(s) on ${plan.upstream}:`);
  for (const line of plan.commits.slice(0, 15)) console.log(`  ${line}`);
  if (plan.commits.length > 15) console.log(`  … and ${plan.commits.length - 15} more`);
};

export const updateCommand = async (parsed: Parsed): Promise<number> => {
  const repo = repoRoot();
  const git = realRun(repo);
  const plan = planUpdate(git);
  if (plan.kind === "blocked") {
    console.error(plan.why);
    return 1;
  }
  if (plan.kind === "current") {
    console.log(`Already up to date (${plan.branch}).`);
    return 0;
  }
  show(plan);
  if (boolFlag(parsed, "check")) {
    console.log("Run `spriessen update` to install them.");
    return 0;
  }
  if (git("git", ["merge", "--ff-only", "--quiet", "@{u}"]) === undefined) {
    console.error(
      "The pull didn't fast-forward cleanly; nothing was changed. Try `git pull` in the checkout.",
    );
    return 1;
  }
  const install = spawnSync(
    "sh",
    [join(repo, "scripts", "install-cli.sh"), "--prefix", launcherDir()],
    // The script skips its first-install advice; update says its own.
    { cwd: repo, stdio: "inherit", env: { ...process.env, SPRIESSEN_NO_NEXT_STEPS: "1" } },
  );
  if (install.status !== 0) {
    console.error(
      "The code is updated, but rebuilding failed (see above). Fix it and run `sh scripts/install-cli.sh`.",
    );
    return 1;
  }
  for (const role of installedDaemons()) {
    console.log(`Restarting the ${role} daemon…`);
    if (control(role, "restart") !== 0)
      console.error(`Couldn't restart it; run \`spriessen daemon restart ${role}\`.`);
  }
  console.log("Updated.");
  return 0;
};
