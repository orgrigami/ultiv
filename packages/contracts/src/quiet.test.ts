import { describe, expect, it } from "vite-plus/test";
import { isNothingToReport, NOTHING_TO_REPORT } from "./quiet.ts";

describe("isNothingToReport", () => {
  it("reads the marker and the small things models add around it", () => {
    for (const text of [
      NOTHING_TO_REPORT,
      "  [Nothing to report]\n",
      "`[nothing to report]`",
      "[nothing to report].",
    ]) {
      expect(isNothingToReport(text)).toBe(true);
    }
  });

  it("anything with more to say is a reply", () => {
    for (const text of [
      "",
      "Nothing to report",
      "[nothing to report] but the build is red",
      "The price dropped. [nothing to report]",
      null,
      undefined,
    ]) {
      expect(isNothingToReport(text)).toBe(false);
    }
  });
});
