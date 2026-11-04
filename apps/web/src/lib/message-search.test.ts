import { describe, expect, it } from "vite-plus/test";
import { highlightParts, speakerOf } from "./message-search.ts";

describe("message search helpers", () => {
  it("names who said a hit", () => {
    expect(speakerOf({ role: "user" }, "Edison")).toBe("You");
    expect(speakerOf({ role: "assistant" }, "Edison")).toBe("Edison");
    expect(speakerOf({ role: "tool" }, "Edison")).toBe("Tool result");
  });

  it("highlights query words at word starts, any case and accent", () => {
    const parts = highlightParts("The Launch date moved; relaunch later", "launch DATE");
    expect(parts.filter((part) => part.hit).map((part) => part.text)).toEqual(["Launch", "date"]);
    expect(parts.map((part) => part.text).join("")).toBe("The Launch date moved; relaunch later");
    expect(highlightParts("Café opens", "cafe").find((part) => part.hit)?.text).toBe("Café");
    expect(highlightParts("anything", "a b")).toEqual([{ text: "anything", hit: false }]);
  });
});
