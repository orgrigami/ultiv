/**
 * The update planner against real git repositories in a temp folder: a
 * clone behind its origin lists the new commits; an up-to-date one says so;
 * uncommitted edits, local commits, a detached HEAD and a branch without an
 * upstream are all refused with a sentence and never touched.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { planUpdate, type Run } from "./update.ts";

const root = mkdtempSync(join(tmpdir(), "spriessen-update-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

const runIn =
  (cwd: string): Run =>
  (command, args) => {
    const result = spawnSync(command, args, { cwd, encoding: "utf8", env: ENV });
    return result.status === 0 ? result.stdout.trim() : undefined;
  };

const sh = (cwd: string, ...args: string[]): void => {
  const out = runIn(cwd)("git", args);
  if (out === undefined) throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
};

/** An origin with one commit and a fresh clone of it; answers both folders. */
const pair = (name: string): { origin: string; clone: string } => {
  const origin = join(root, `${name}-origin`);
  const clone = join(root, `${name}-clone`);
  sh(root, "init", "--quiet", "--initial-branch=main", origin);
  writeFileSync(join(origin, "a.txt"), "1\n");
  sh(origin, "add", ".");
  sh(origin, "commit", "--quiet", "-m", "first");
  sh(root, "clone", "--quiet", origin, clone);
  return { origin, clone };
};

const commit = (cwd: string, file: string, message: string): void => {
  writeFileSync(join(cwd, file), message);
  sh(cwd, "add", ".");
  sh(cwd, "commit", "--quiet", "-m", message);
};

describe("planUpdate", () => {
  it("lists the new commits of a clone that is behind", () => {
    const { origin, clone } = pair("behind");
    commit(origin, "b.txt", "feat: second");
    commit(origin, "c.txt", "fix: third");
    const plan = planUpdate(runIn(clone));
    expect(plan.kind).toBe("behind");
    if (plan.kind !== "behind") return;
    expect(plan.upstream).toBe("origin/main");
    expect(plan.commits.map((line) => line.replace(/^\w+ /, ""))).toEqual([
      "fix: third",
      "feat: second",
    ]);
  });

  it("says so when there is nothing new", () => {
    const { clone } = pair("current");
    expect(planUpdate(runIn(clone))).toEqual({ kind: "current", branch: "main" });
  });

  it("refuses uncommitted edits, but not untracked files", () => {
    const { clone } = pair("dirty");
    writeFileSync(join(clone, "untracked.txt"), "x");
    expect(planUpdate(runIn(clone)).kind).toBe("current");
    writeFileSync(join(clone, "a.txt"), "edited\n");
    const plan = planUpdate(runIn(clone));
    expect(plan).toMatchObject({
      kind: "blocked",
      why: expect.stringMatching(/uncommitted changes/),
    });
  });

  it("refuses local commits the upstream lacks", () => {
    const { clone } = pair("ahead");
    commit(clone, "mine.txt", "wip: mine");
    expect(planUpdate(runIn(clone))).toMatchObject({
      kind: "blocked",
      why: expect.stringMatching(/1 local commit\(s\).*only fast-forwards/),
    });
  });

  it("refuses a detached HEAD and a branch without an upstream", () => {
    const { clone } = pair("odd");
    sh(clone, "checkout", "--quiet", "--detach");
    expect(planUpdate(runIn(clone))).toMatchObject({ why: expect.stringMatching(/detached HEAD/) });
    sh(clone, "checkout", "--quiet", "-b", "solo");
    expect(planUpdate(runIn(clone))).toMatchObject({
      why: expect.stringMatching(/doesn't track a remote/),
    });
  });

  it("refuses a folder that is not a checkout", () => {
    const bare = mkdtempSync(join(root, "plain-"));
    expect(planUpdate(runIn(bare))).toMatchObject({
      why: expect.stringMatching(/isn't a git checkout/),
    });
  });
});
