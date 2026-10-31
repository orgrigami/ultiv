import { describe, expect, it } from "vite-plus/test";
import { linkBadge } from "./link-state.ts";

describe("linkBadge", () => {
  it("shows nothing while connected", () => {
    expect(linkBadge("live")).toBeNull();
  });

  it("a quiet dot while connecting, a warning with a word once lost", () => {
    expect(linkBadge("connecting")).toMatchObject({ kind: "pending", label: null });
    expect(linkBadge("lost")).toMatchObject({
      kind: "error",
      tone: "signal",
      label: "disconnected",
    });
  });
});
