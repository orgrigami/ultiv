import { describe, expect, it } from "vite-plus/test";
import { networkText, statusText } from "./error-words.ts";

describe("statusText", () => {
  it("words the common statuses without the method or path", () => {
    expect(statusText(404)).toBe("That's no longer here.");
    expect(statusText(503)).toContain("isn't answering");
    expect(statusText(500)).toContain("hit an error");
    expect(statusText(418)).toBe("The request failed (418).");
  });
});

describe("networkText", () => {
  it("rewords every engine's failed fetch", () => {
    for (const raw of [
      "Failed to fetch",
      "NetworkError when attempting to fetch resource.",
      "Load failed",
    ]) {
      expect(networkText(raw)).toBe("Can't reach the server. Check your connection and try again.");
    }
  });

  it("leaves server sentences alone", () => {
    expect(networkText("That bot talk no longer exists.")).toBe("That bot talk no longer exists.");
  });
});
