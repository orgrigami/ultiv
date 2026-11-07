import { describe, expect, it } from "vite-plus/test";
import type { TranscriptEntry } from "@spriessen/contracts";
import { entryLines } from "./words.ts";

const output = (text: string, streaming = false): TranscriptEntry =>
  ({ kind: "output", id: 1, at: 0, text, streaming }) as TranscriptEntry;

describe("entryLines", () => {
  it("a routine's [nothing to report] is one quiet line, not a reply", () => {
    expect(entryLines(output("[nothing to report]"), "Wren")).toEqual([
      "· Wren: checked in: nothing to report",
    ]);
  });

  it("a reply prints under the bot's name", () => {
    expect(entryLines(output("Prices dropped."), "Wren")).toEqual(["Wren", "  Prices dropped."]);
  });

  it("the marker still streaming is not judged yet", () => {
    expect(entryLines(output("[nothing to", true), "Wren")[0]).toBe("Wren");
  });
});
