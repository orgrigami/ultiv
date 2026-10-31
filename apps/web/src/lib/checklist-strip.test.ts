import { describe, expect, it } from "vite-plus/test";
import { CHECKLIST_TOOL } from "@spriessen/contracts";
import { currentPlan, planKey, stripLine } from "./checklist-strip.ts";

const list = (id: string, statuses: string[]) => ({
  listId: id,
  title: null,
  items: statuses.map((status, index) => ({ text: `Step ${index + 1}`, status })),
});
const call = (details: unknown, status = "done", name = CHECKLIST_TOOL) => ({
  kind: "tool",
  step: { id: "t", name, status, input: {}, details } as never,
});

describe("currentPlan", () => {
  it("takes the latest settled checklist call", () => {
    const transcript = [
      call(list("a", ["done", "pending"])),
      { kind: "assistant" },
      call(list("a", ["done", "in_progress"])),
      call(list("b", ["pending"]), "running"),
      call({ other: true }, "done", "bash"),
    ];
    expect(currentPlan(transcript)?.items[1]?.status).toBe("in_progress");
  });
  it("is null without a plan or with a malformed one", () => {
    expect(currentPlan([{ kind: "user" }])).toBeNull();
    expect(currentPlan([call({ listId: "x", items: [] })])).toBeNull();
  });
});

describe("stripLine", () => {
  it("counts done steps and names the one in progress, else the next", () => {
    expect(stripLine(list("a", ["done", "done", "in_progress", "pending"]) as never)).toEqual({
      done: 2,
      total: 4,
      current: "Step 3",
      finished: false,
    });
    expect(stripLine(list("a", ["done", "pending"]) as never).current).toBe("Step 2");
  });
  it("is finished with no current step once all are done", () => {
    expect(stripLine(list("a", ["done", "done"]) as never)).toMatchObject({
      current: null,
      finished: true,
    });
  });
});

describe("planKey", () => {
  it("changes with any step's state and stays put otherwise", () => {
    const one = list("a", ["done", "pending"]) as never;
    expect(planKey(one)).toBe(planKey(list("a", ["done", "pending"]) as never));
    expect(planKey(one)).not.toBe(planKey(list("a", ["done", "done"]) as never));
    expect(planKey(null)).toBe("");
  });
});
