import { describe, expect, it } from "vite-plus/test";
import { cardLine, tabCount } from "@/lib/profile-summary";
import { expectLine } from "./test-case-row";

const bot = { policies: { approvalMode: "manual" as const }, toolAllowlist: null };

describe("tests tab words", () => {
  it("says what a test expects in one line, or nothing", () => {
    expect(expectLine({})).toBeNull();
    expect(
      expectLine({
        contains: ["3 emails"],
        tools: ["web_search"],
        notTools: ["bash"],
        rubric: "brief",
      }),
    ).toBe('says "3 emails" · calls web_search · never calls bash · rule: brief');
  });

  it("counts tests on the tab and its overview card", () => {
    expect(tabCount("tests", { tests: 2 }, bot)).toBe(2);
    expect(cardLine("tests", { tests: 0 }, bot)).toBe("No tests yet");
    expect(cardLine("tests", { tests: 2 }, bot)).toBe("2 tests to replay after a change");
  });
});
