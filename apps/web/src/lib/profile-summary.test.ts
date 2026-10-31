import { describe, expect, it } from "vite-plus/test";
import { cardLine, tabCount } from "./profile-summary.ts";

const open = { policies: { approvalMode: "manual" as const }, toolAllowlist: null };

describe("profile tab counts", () => {
  it("shows loaded counts and hides unknown ones", () => {
    expect(tabCount("memory", { memory: 3 }, open)).toBe(3);
    expect(tabCount("routines", {}, open)).toBeUndefined();
    expect(tabCount("files", { files: 0 }, open)).toBe(0);
    expect(tabCount("overview", { memory: 3 }, open)).toBeUndefined();
  });
  it("counts access only when the tool list is narrowed", () => {
    expect(tabCount("access", {}, open)).toBeUndefined();
    expect(
      tabCount("access", {}, { policies: { approvalMode: "jev" }, toolAllowlist: ["bash", "web"] }),
    ).toBe(2);
  });
});

describe("overview card lines", () => {
  it("reads plainly for each state", () => {
    expect(cardLine("memory", {}, open)).toBe("What it remembers about you");
    expect(cardLine("memory", { memory: 0 }, open)).toBe("Nothing remembered yet");
    expect(cardLine("memory", { memory: 1 }, open)).toBe("1 fact it keeps about you");
    expect(cardLine("routines", { routines: 2 }, open)).toBe("2 routines on a schedule or trigger");
    expect(cardLine("files", { files: 0 }, open)).toBe("No files yet");
    expect(cardLine("access", {}, open)).toBe("Manual approvals · every tool");
    expect(cardLine("access", {}, { policies: { approvalMode: "yolo" }, toolAllowlist: [] })).toBe(
      "YOLO approvals · no tools",
    );
  });
});
