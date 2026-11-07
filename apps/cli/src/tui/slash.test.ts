import { describe, expect, it } from "vite-plus/test";
import type { TranscriptEntry } from "@spriessen/contracts";
import { lastOwnerMessage, lastReply, messageOf, parseSlash } from "./slash.ts";

describe("slash commands", () => {
  it("reads commands and leaves messages alone", () => {
    expect(parseSlash("hello")).toBeNull();
    expect(parseSlash("//etc/hosts is odd")).toBeNull();
    expect(messageOf("//etc/hosts is odd")).toBe("/etc/hosts is odd");
    expect(parseSlash("/edit")).toEqual({ kind: "edit", text: "" });
    expect(parseSlash("/edit book a  plane")).toEqual({ kind: "edit", text: "book a  plane" });
    expect(parseSlash("/bot wren")).toEqual({ kind: "bot", name: "wren" });
    expect(parseSlash("/bot")).toEqual({ kind: "help" });
    expect(parseSlash("/BRANCH")).toEqual({ kind: "branch" });
    expect(parseSlash("/frobnicate")).toEqual({ kind: "unknown", name: "frobnicate" });
  });

  it("finds your last message (not machinery) and the last finished reply", () => {
    const transcript: TranscriptEntry[] = [
      { id: 100, kind: "input", at: 0, text: "plan the trip" },
      { id: 200, kind: "output", at: 1, text: "Here is a plan.", streaming: false },
      { id: 300, kind: "input", at: 2, text: "[task t1 finished] done" },
      { id: 400, kind: "output", at: 3, text: "Still writing", streaming: true },
    ];
    expect(lastOwnerMessage(transcript)).toEqual({ id: 100, text: "plan the trip" });
    expect(lastReply(transcript)).toBe(200);
    expect(lastOwnerMessage([])).toBeUndefined();
  });
});
