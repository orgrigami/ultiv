import { describe, expect, it } from "vite-plus/test";
import { presentationOf } from "./tool-text.ts";
import { timelineOf, toolStepOf, type TimelineItem } from "./task-steps.ts";

const brief = "Research the textual basis of a live dispute over Aristotle";
const toolsOf = (items: TimelineItem[]) =>
  items.filter((item): item is Extract<TimelineItem, { kind: "tool" }> => item.kind === "tool");

describe("timelineOf", () => {
  it("drops the brief and the final result, keeps the rest in order", () => {
    const items = timelineOf(
      [
        { kind: "input", at: 1, text: brief.slice(0, 30) },
        { kind: "thinking", at: 2, text: "plan" },
        { kind: "tool", at: 3, text: 'now → {"utc":"z"}' },
        {
          kind: "tool",
          at: 4,
          text: "web_fetch …",
          tool: {
            name: "web_fetch",
            status: "running",
            input: { urls: ["https://a.org"] },
            output: null,
            durationMs: null,
          },
        },
        { kind: "note", at: 5, text: "[task t1 update] halfway" },
        { kind: "output", at: 6, text: "Final answer" },
      ],
      brief,
      "Final answer",
    );
    expect(items.map((item) => item.kind)).toEqual(["thinking", "tool", "tool", "note"]);
    const [legacy, live] = toolsOf(items);
    // A legacy "name → output" row reads its name and output back out.
    expect(legacy).toMatchObject({ name: "now", status: "done", outputRaw: '{"utc":"z"}' });
    expect(live).toMatchObject({ name: "web_fetch", status: "running", outputRaw: null });
    expect(items[3]).toMatchObject({ text: "halfway" });
  });

  it("keeps bot messages that are not the result", () => {
    const items = timelineOf([{ kind: "output", at: 1, text: "Working on it" }], brief, null);
    expect(items).toEqual([{ kind: "message", key: "1-0", text: "Working on it" }]);
  });
});

describe("toolStepOf", () => {
  it("hands task rows to the same lens a chat uses", () => {
    const [row] = toolsOf(
      timelineOf(
        [
          {
            kind: "tool",
            at: 1,
            text: "web_search",
            tool: {
              name: "web_search",
              status: "done",
              input: '{"query":"four causes"}',
              output: '{"hits":[]}',
              durationMs: 40,
            },
          },
        ],
        brief,
        null,
      ),
    );
    const step = toolStepOf(row!);
    expect(step.input).toEqual({ query: "four causes" });
    expect(step.output).toContain('"hits"');
    expect(presentationOf(step).kind).toBe("human");
  });

  it("keeps the lens's hidden tools hidden in tasks too", () => {
    const [row] = toolsOf(timelineOf([{ kind: "tool", at: 1, text: "now → {}" }], brief, null));
    expect(presentationOf(toolStepOf(row!)).kind).toBe("hidden");
  });
});
