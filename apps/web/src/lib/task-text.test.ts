import { describe, expect, it } from "vite-plus/test";
import type { TaskInfo } from "@spreissen/contracts";
import {
  formatElapsed,
  pillLabel,
  pillTasks,
  taskElapsed,
  taskLatest,
  taskTitle,
} from "./task-text.ts";

const task = (over: Partial<TaskInfo> = {}): TaskInfo => ({
  id: "t",
  sessionId: "",
  owner: "agent",
  conversationId: "c",
  prompt: "Find cheap flights to Bali\nwith details",
  status: "running",
  result: null,
  error: null,
  createdAt: 0,
  finishedAt: null,
  ...over,
});

describe("task text", () => {
  it("titles: the bot's title, else the brief's first line, capped", () => {
    expect(taskTitle(task({ title: "Flight prices" }))).toBe("Flight prices");
    expect(taskTitle(task())).toBe("Find cheap flights to Bali");
    expect(taskTitle(task({ prompt: "x".repeat(60) }))).toHaveLength(40);
    expect(taskTitle(task({ prompt: "" }))).toBe("Background task");
  });

  it("formats elapsed time", () => {
    expect(formatElapsed(4_000)).toBe("4s");
    expect(formatElapsed(185_000)).toBe("3m 05s");
    expect(formatElapsed(4_380_000)).toBe("1h 13m");
    expect(taskElapsed(task({ createdAt: 1_000, finishedAt: 61_000 }), 999_999)).toBe("1m 00s");
  });

  it("prefers the latest progress update over the latest step", () => {
    expect(taskLatest(task({ lastStep: "Used web search" }))).toBe("Used web search");
    expect(
      taskLatest(task({ lastStep: "Used web search", updates: [{ at: 1, text: "Found 3" }] })),
    ).toBe("Found 3");
  });

  it("summarises the pill", () => {
    const now = 1_000_000;
    const done = task({ status: "done", finishedAt: now - 1_000 });
    const old = task({ status: "done", finishedAt: now - 3_600_000 });
    expect(pillTasks([task(), done, old], now)).toHaveLength(2);
    expect(pillLabel([task(), task()])).toBe("2 tasks running");
    expect(pillLabel([task(), done])).toBe("1 task running · 1 done");
    expect(pillLabel([done])).toBe("Task done");
    expect(pillLabel([task({ status: "failed" })])).toBe("Task failed");
    expect(pillLabel([task({ status: "cancelled" })])).toBe("Task stopped");
    expect(pillLabel([done, task({ status: "failed" })])).toBe("2 tasks finished · 1 failed");
  });
});
