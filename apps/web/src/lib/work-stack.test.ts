import { describe, expect, it } from "vite-plus/test";
import type { TaskInfo } from "@ultiv/contracts";
import { WORK_STACK_LIMIT, workKey, workStack, type WorkItem } from "./work-stack.ts";

const file = (id: string): WorkItem => ({ kind: "file", file: { id, name: `${id}.txt` } });
const task = (id: string, title: string): WorkItem => ({
  kind: "task",
  task: { id, title } as unknown as TaskInfo,
});

describe("workStack", () => {
  it("pushes, goes back and closes", () => {
    let stack = workStack([], { type: "open", item: task("t1", "a") });
    stack = workStack(stack, { type: "open", item: file("f1") });
    expect(stack.map(workKey)).toEqual(["task:t1", "file:f1"]);
    stack = workStack(stack, { type: "back" });
    expect(stack.map(workKey)).toEqual(["task:t1"]);
    expect(workStack(stack, { type: "close" })).toEqual([]);
  });
  it("replaces the top when the same thing opens again", () => {
    const stack = workStack([task("t1", "old")], { type: "open", item: task("t1", "new") });
    expect(stack).toHaveLength(1);
    expect(stack[0]).toMatchObject({ task: { title: "new" } });
  });
  it("starts a new trail on a fresh open", () => {
    const stack = workStack([task("t1", "a"), file("f1")], {
      type: "open",
      item: { kind: "needs" },
      fresh: true,
    });
    expect(stack.map(workKey)).toEqual(["needs"]);
  });
  it("keeps the trail short", () => {
    let stack: readonly WorkItem[] = [];
    for (let index = 0; index < 10; index++)
      stack = workStack(stack, { type: "open", item: file(`f${index}`) });
    expect(stack).toHaveLength(WORK_STACK_LIMIT);
    expect(stack.at(-1)).toMatchObject({ file: { id: "f9" } });
  });
  it("keys memory by bot", () => {
    expect(workKey({ kind: "memory", profileId: "b1", name: "Atlas", query: "x" })).toBe(
      "memory:b1",
    );
  });
});
