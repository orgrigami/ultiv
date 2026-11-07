import { describe, expect, it } from "vite-plus/test";
import type { CronJobInfo, ProjectInfo, TaskInfo } from "@spriessen/contracts";
import { linkTarget, projectWork, workText } from "./links.ts";

const project = (id: string, status: ProjectInfo["status"] = "active"): ProjectInfo => ({
  id,
  owner: "o",
  profileId: "p",
  title: `Project ${id.slice(0, 4)}`,
  goal: "",
  status,
  milestones: [],
  log: [],
  createdAt: 0,
  updatedAt: 0,
});

const task = (id: string, projectId: string | undefined, createdAt: number): TaskInfo => ({
  id,
  sessionId: "s",
  owner: "agent",
  conversationId: null,
  prompt: `Do ${id}`,
  status: "done",
  result: null,
  error: null,
  createdAt,
  finishedAt: createdAt + 1,
  ...(projectId !== undefined ? { projectId } : {}),
});

const job = (id: string, projectId: string | undefined): CronJobInfo => ({
  id,
  sessionId: "s",
  profile: "p",
  schedule: "0 9 * * 1",
  once: null,
  prompt: "Weekly check-in",
  enabled: true,
  failures: 0,
  createdAt: 0,
  lastRunAt: null,
  lastError: null,
  ...(projectId !== undefined ? { projectId } : {}),
});

describe("project links", () => {
  it("link only to an open project of the bot's own, by handle", () => {
    const rows = [project("aaaa1111-x"), project("bbbb2222-y", "done")];
    expect(linkTarget(rows, "#aaaa1111")).toEqual({ id: "aaaa1111-x", title: "Project aaaa" });
    expect(linkTarget(rows, "bbbb2222")).toMatch(/no project #bbbb2222 among your open projects/);
    expect(linkTarget(rows, "#a")).toMatch(/at least 4 characters/);
  });

  it("fold the tasks and routines that carry the project's id", () => {
    const work = projectWork(
      "p1",
      [
        task("t-old", "p1", 1),
        task("t-other", "p2", 2),
        task("t-new", "p1", 3),
        task("t-none", undefined, 4),
      ],
      [job("j1", "p1"), job("j2", undefined)],
    );
    expect(work.tasks.map((row) => row.id)).toEqual(["t-new", "t-old"]);
    expect(work.tasks[0]?.title).toBe("Do t-new");
    expect(work.routines.map((row) => row.id)).toEqual(["j1"]);
  });

  it("read as lines under the project's show", () => {
    expect(workText({ tasks: [], routines: [] })).toEqual(["no linked tasks or routines yet"]);
    const lines = workText(
      projectWork("p1", [task("t1234567-z", "p1", 1)], [job("j7654321", "p1")]),
    );
    expect(lines[0]).toBe("Linked work:");
    expect(lines[1]).toBe("task t1234567 [done] Do t1234567-z");
    expect(lines[2]).toBe('routine j7654321 cron "0 9 * * 1": Weekly check-in');
  });
});
