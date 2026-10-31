import { describe, expect, it } from "vite-plus/test";
import { reconnectDelay } from "./chord.ts";

describe("reconnectDelay", () => {
  it("starts at half a second, doubles, and stops at ten", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(reconnectDelay)).toEqual([
      500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000,
    ]);
    expect(reconnectDelay(-1)).toBe(500);
  });
});
