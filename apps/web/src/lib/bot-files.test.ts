import { describe, expect, it } from "vite-plus/test";
import { saveProblem, versionLine } from "./bot-files.ts";

describe("bot files wording", () => {
  it("names who saved each version and why", () => {
    const line = versionLine({ n: 3, text: "", at: 0, by: "owner", reason: "Restored version 1" });
    expect(line.startsWith("v3 · you · ")).toBe(true);
    expect(line.endsWith("Restored version 1")).toBe(true);
    expect(versionLine({ n: 1, text: "", at: 0, by: "migration", reason: "x" })).toContain(
      "the upgrade",
    );
  });

  it("offers save only for a change within the limit", () => {
    expect(saveProblem("persona", "same", "same")).toBe("");
    expect(saveProblem("persona", "new", "old")).toBeNull();
    expect(saveProblem("persona", "x".repeat(8_001), "")).toContain("at most 8000");
  });
});
