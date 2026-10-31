/** Bug 3: the dialog checks deadlines itself, in its own words, before sending. */
import { describe, expect, it } from "vite-plus/test";
import { deadlineFieldProblem, deadlineValue, formProblem } from "./deadline-fields.ts";

const form = (firstTokenSec: string, turnMin: string) => ({ firstTokenSec, turnMin });

describe("Edit-bot dialog deadlines (bug 3)", () => {
  it("accepts empty (the default) and whole numbers within bounds", () => {
    expect(formProblem(form("", ""))).toBeNull();
    expect(formProblem(form("120", "30"))).toBeNull();
    expect(deadlineValue("", "firstTokenDeadlineSec")).toBeNull();
    expect(deadlineValue(" 120 ", "firstTokenDeadlineSec")).toBe(120);
  });

  it("refuses out-of-range, fractional and non-numbers with the dialog's labels", () => {
    for (const text of ["5", "1801", "12.5", "abc"]) {
      const problem = deadlineFieldProblem(text, "firstTokenDeadlineSec");
      expect(problem).toBe(
        "First reply (seconds) must be a whole number from 10 to 1800. Leave it empty for the default.",
      );
    }
    const turn = formProblem(form("", "0"));
    expect(turn).toContain("Whole turn (minutes)");
    expect(turn).not.toMatch(/firstTokenDeadlineSec|turnDeadlineMin|null/);
  });

  it("never builds a patch from a bad value", () => {
    expect(() => deadlineValue("12.5", "firstTokenDeadlineSec")).toThrow(/First reply/);
    expect(() => deadlineValue("721", "turnDeadlineMin")).toThrow(/Whole turn/);
  });
});
