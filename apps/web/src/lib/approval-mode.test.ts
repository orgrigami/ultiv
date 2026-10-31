import { describe, expect, it } from "vite-plus/test";
import { isApprovalMode, MODE_CHIP, needsConfirm } from "./approval-mode.ts";

describe("approval mode chip", () => {
  it("labels each mode briefly and flags only YOLO", () => {
    expect(MODE_CHIP.manual.label).toBe("Manual");
    expect(MODE_CHIP.jev.label).toBe("Jev");
    expect(MODE_CHIP.yolo.label).toBe("YOLO");
    expect(MODE_CHIP.yolo.tone).toBe("warning");
    expect(MODE_CHIP.jev.tone).toBe("neutral");
  });

  it("asks before switching into YOLO, from any mode", () => {
    expect(needsConfirm("manual", "yolo")).toBe(true);
    expect(needsConfirm("jev", "yolo")).toBe(true);
  });

  it("never asks to switch back to a safer mode or to stay", () => {
    expect(needsConfirm("yolo", "yolo")).toBe(false);
    expect(needsConfirm("yolo", "manual")).toBe(false);
    expect(needsConfirm("manual", "jev")).toBe(false);
    expect(needsConfirm("jev", "manual")).toBe(false);
  });

  it("recognises only the three modes", () => {
    expect(isApprovalMode("jev")).toBe(true);
    expect(isApprovalMode("auto")).toBe(false);
  });
});
