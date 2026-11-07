import { describe, expect, it } from "vite-plus/test";
import { NODE_MAJOR, nodeVersionProblem } from "./node-version.ts";

describe("nodeVersionProblem", () => {
  it("accepts the pinned line", () => {
    expect(nodeVersionProblem(`${NODE_MAJOR}.13.0`)).toBeUndefined();
    expect(nodeVersionProblem(`v${NODE_MAJOR}.0.0`)).toBeUndefined();
  });

  it("refuses an older line", () => {
    const problem = nodeVersionProblem("24.11.0");
    expect(problem?.fatal).toBe(true);
    expect(problem?.text).toContain("needs Node 26");
  });

  it("warns on a newer line without refusing", () => {
    expect(nodeVersionProblem("28.0.0")).toEqual({
      fatal: false,
      text: expect.stringContaining("tested on Node 26"),
    });
  });

  it("refuses a version it cannot read", () => {
    expect(nodeVersionProblem("banana")?.fatal).toBe(true);
  });

  it("matches the process this test runs on", () => {
    expect(nodeVersionProblem()).toBeUndefined();
  });
});
