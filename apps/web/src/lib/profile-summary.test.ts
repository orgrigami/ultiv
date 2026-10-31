import { describe, expect, it } from "vite-plus/test";
import { ACTIVITY_LIMIT, cardLine, tabCount } from "./profile-summary.ts";

const open = { policies: { approvalMode: "manual" as const }, toolAllowlist: null };

describe("profile tab counts", () => {
  it("shows loaded counts and hides unknown ones", () => {
    expect(tabCount("memory", { memory: 3 }, open)).toBe(3);
    expect(tabCount("routines", {}, open)).toBeUndefined();
    expect(tabCount("files", { files: 0 }, open)).toBe(0);
    expect(tabCount("overview", { memory: 3 }, open)).toBeUndefined();
  });
  it("counts every tab but Overview from the data it shows", () => {
    expect(tabCount("instructions", { versions: 3 }, open)).toBe(3);
    expect(tabCount("activity", { activity: 7 }, open)).toBe(7);
    expect(tabCount("activity", { activity: ACTIVITY_LIMIT }, open)).toBe(`${ACTIVITY_LIMIT}+`);
    expect(tabCount("activity", {}, open)).toBeUndefined();
  });
  it("counts allowed tools, or All when the list isn't narrowed", () => {
    expect(tabCount("access", {}, open)).toBe("All");
    expect(tabCount("access", {}, { policies: { approvalMode: "jev" }, toolAllowlist: [] })).toBe(
      0,
    );
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
    expect(cardLine("instructions", { versions: 1 }, open)).toBe(
      "Persona and instructions · 1 version saved",
    );
    expect(cardLine("access", {}, open)).toBe("Manual approvals · every tool");
    expect(cardLine("access", {}, { policies: { approvalMode: "yolo" }, toolAllowlist: [] })).toBe(
      "YOLO approvals · no tools",
    );
  });
});
