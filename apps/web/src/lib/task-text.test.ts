import { describe, expect, it } from "vite-plus/test";
import type { TaskInfo } from "@spriessen/contracts";
import {
  formatElapsed,
  chipLabel,
  taskMeta,
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

  it("says the same meta line on every surface", () => {
    const now = 200_000;
    expect(taskMeta(task({ startedAt: 15_000, lastStep: "Searching the web" }), now)).toBe(
      "Running · 3m 05s · Searching the web",
    );
    expect(taskMeta(task({ status: "queued" }), now)).toBe("Queued · waits for a free slot");
    expect(taskMeta(task({ status: "done", finishedAt: 60_000, runs: 2 }), now)).toBe(
      "Done · 1m 00s · run 2",
    );
  });

  it("counts the header chip", () => {
    expect(chipLabel([task(), task()])).toBe("2 running");
    expect(chipLabel([task(), task({ status: "queued" })])).toBe("1 running · 1 queued");
    expect(chipLabel([task({ status: "queued" })])).toBe("1 queued");
  });
});
