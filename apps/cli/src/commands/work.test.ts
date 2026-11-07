import { describe, expect, it } from "vite-plus/test";
import type { EvalCase, EvalRun } from "@spriessen/contracts";
import { askText } from "./line.ts";
import { resultLines } from "./work.ts";

describe("line commands", () => {
  it("reads the ask message from stdin for - or a pipe", async () => {
    const piped = async () => "  from a pipe \n";
    expect(await askText("-", true, piped)).toBe("from a pipe");
    expect(await askText("", false, piped)).toBe("from a pipe");
    expect(await askText("typed", false, piped)).toBe("typed");
    expect(await askText("", true, piped)).toBe("");
  });

  it("prints each test's outcome, the failing checks, and the tally", () => {
    const cases = [
      { id: "c1", title: "inbox" },
      { id: "c2", title: "trip" },
    ] as EvalCase[];
    const run = {
      id: "r",
      owner: "o",
      model: "kenari/small",
      status: "done",
      caseIds: ["c1", "c2"],
      results: [
        { caseId: "c1", ok: true, reply: "", tools: [], checks: [], score: 0.9, error: null },
        {
          caseId: "c2",
          ok: false,
          reply: "",
          tools: [],
          checks: [{ name: "calls web_search", ok: false, detail: "called no tools" }],
          score: 0.4,
          error: null,
        },
      ],
      startedAt: 0,
      finishedAt: 1,
      error: null,
    } as EvalRun;
    expect(resultLines(run, cases)).toEqual([
      "✓ inbox (Jev 0.90)",
      "✗ trip (Jev 0.40)",
      "    calls web_search: called no tools",
      "1 of 2 passed on kenari/small.",
    ]);
  });
});
