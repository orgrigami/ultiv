import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { Receipts } from "./tool-receipts.tsx";
import { rowsOf } from "./task-sheet/timeline.tsx";
import { doingOf, type TimelineItem } from "../lib/task-steps.ts";

describe("Receipts for a tool no lens knows", () => {
  const input = { teamId: "ENG", labels: ["frontend", "weather"], priority: 2 };

  it("reads input as labelled rows and a flat JSON answer as rows, not braces", () => {
    const html = renderToStaticMarkup(
      <Receipts
        input={input}
        output={JSON.stringify({ id: "ENG-412", url: "https://linear.app/x/ENG-412" })}
      />,
    );
    expect(html).toContain(">Sent<");
    expect(html).toContain(">Got back<");
    expect(html).toContain(">Team Id<");
    // A list of words reads as chips, a link as a link.
    expect(html).toContain(">frontend<");
    expect(html).toContain('href="https://linear.app/x/ENG-412"');
    expect(html).not.toContain("{");
  });

  it("keeps deep JSON as a highlighted block", () => {
    const html = renderToStaticMarkup(
      <Receipts
        input={{}}
        output={JSON.stringify({ issue: { id: "ENG-412", team: { key: "ENG" } } })}
      />,
    );
    expect(html).toContain("result");
    expect(html).not.toContain(">Got back<");
  });

  it("shows nothing for a call with no input and no output", () => {
    expect(renderToStaticMarkup(<Receipts input={{}} output="" />)).toBe("");
  });
});

const tool = (key: string, status: "running" | "done" = "done"): TimelineItem => ({
  kind: "tool",
  key,
  name: "web_search",
  status,
  durationMs: null,
  inputRaw: { query: "x" },
  outputRaw: null,
});

describe("the task timeline", () => {
  it("groups consecutive calls and numbers calls only", () => {
    const rows = rowsOf([
      { kind: "thinking", key: "t", text: "hmm" },
      tool("a"),
      tool("b"),
      { kind: "note", key: "n", text: "halfway" },
      tool("c"),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["step", "tools", "step", "tools"]);
    const calls = rows.flatMap((row) =>
      row.kind === "tools" ? row.tools.map((t) => t.index) : [],
    );
    expect(calls).toEqual([1, 2, 3]);
  });

  it("says what a running task is doing in its newest row's words", () => {
    expect(doingOf([tool("a", "running")], false)).toBe("Searching the web…");
    expect(doingOf([{ kind: "thinking", key: "t", text: "" }], false)).toBe("Thinking…");
    expect(doingOf([tool("a")], false)).toBe("Working…");
    expect(doingOf([tool("a", "running")], true)).toBe("Waiting for your approval");
  });
});
