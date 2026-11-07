import { describe, expect, it } from "vite-plus/test";
import type { ProjectInfo, TaskInfo } from "@spriessen/contracts";
import {
  botNameOf,
  FINISHED_WINDOW_MS,
  finishedRecently,
  goalsInMotion,
  milestoneText,
  runningWork,
} from "./now.ts";

const NOW = 10 * FINISHED_WINDOW_MS;

const task = (id: string, patch: Partial<TaskInfo>): TaskInfo => ({
  id,
  sessionId: "s",
  owner: "o",
  conversationId: null,
  prompt: id,
  status: "running",
  result: null,
  error: null,
  createdAt: 0,
  finishedAt: null,
  ...patch,
});

const project = (id: string, patch: Partial<ProjectInfo>): ProjectInfo => ({
  id,
  owner: "o",
  profileId: "p",
  title: id,
  goal: "",
  status: "active",
  milestones: [],
  log: [],
  createdAt: 0,
  updatedAt: 0,
  ...patch,
});

describe("the Now folds", () => {
  it("list running work across bots, newest first", () => {
    const rows = [
      task("a", { createdAt: 1 }),
      task("b", { status: "done", finishedAt: NOW }),
      task("c", { createdAt: 3 }),
    ];
    expect(runningWork(rows).map((row) => row.id)).toEqual(["c", "a"]);
  });

  it("keep clean finishes from the last day; failures belong to Needs you", () => {
    const rows = [
      task("old", { status: "done", finishedAt: NOW - FINISHED_WINDOW_MS - 1 }),
      task("fresh", { status: "done", finishedAt: NOW - 10 }),
      task("stopped", { status: "cancelled", finishedAt: NOW - 5 }),
      task("broke", { status: "failed", finishedAt: NOW - 1 }),
    ];
    expect(finishedRecently(rows, NOW).map((row) => row.id)).toEqual(["stopped", "fresh"]);
  });

  it("name the bot a task runs as", () => {
    const profiles = [{ id: "p1", name: "Ada" }];
    expect(botNameOf({ bot: { owner: "o", profileId: "p1" } }, profiles)).toBe("Ada");
    expect(botNameOf({}, profiles)).toBe("");
  });

  it("show active goals before paused ones, and never closed ones", () => {
    const rows = [
      project("paused", { status: "paused", updatedAt: 9 }),
      project("done", { status: "done" }),
      project("active-old", { updatedAt: 1 }),
      project("active-new", { updatedAt: 5 }),
    ];
    expect(goalsInMotion(rows).map((row) => row.id)).toEqual([
      "active-new",
      "active-old",
      "paused",
    ]);
  });

  it("count milestones in words", () => {
    expect(milestoneText({ milestones: [] })).toBe("No milestones yet");
    expect(
      milestoneText({
        milestones: [
          { text: "a", done: true, doneAt: 1 },
          { text: "b", done: false, doneAt: null },
        ],
      }),
    ).toBe("1 of 2 milestones");
  });
});
