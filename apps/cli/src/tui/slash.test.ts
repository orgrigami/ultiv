import { describe, expect, it } from "vite-plus/test";
import type { TranscriptEntry } from "@spriessen/contracts";
import {
  completeSlash,
  lastOwnerMessage,
  lastReply,
  messageOf,
  parseSlash,
  slashMatches,
} from "./slash.ts";

describe("slash commands", () => {
  it("reads commands and leaves messages alone", () => {
    expect(parseSlash("hello")).toBeNull();
    expect(parseSlash("//etc/hosts is odd")).toBeNull();
    expect(messageOf("//etc/hosts is odd")).toBe("/etc/hosts is odd");
    expect(parseSlash("/edit")).toEqual({ kind: "edit", text: "" });
    expect(parseSlash("/edit book a  plane")).toEqual({ kind: "edit", text: "book a  plane" });
    expect(parseSlash("/bot wren")).toEqual({ kind: "bot", name: "wren" });
    expect(parseSlash("/bot")).toEqual({ kind: "bot", name: "" });
    expect(parseSlash("/model kenari/x")).toEqual({ kind: "model", id: "kenari/x" });
    expect(parseSlash("/chats")).toEqual({ kind: "chats" });
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
    expect(lastReply(transcript)).toEqual({ id: 200, text: "Here is a plan." });
    expect(lastOwnerMessage([])).toBeUndefined();
  });

  it("hints and completes half-typed commands, never a message or a command with words", () => {
    expect(slashMatches("/b").map((spec) => spec.name)).toEqual(["bot", "branch"]);
    expect(slashMatches("/bot wren")).toEqual([]);
    expect(slashMatches("//x")).toEqual([]);
    expect(slashMatches("hello")).toEqual([]);
    expect(completeSlash("/co")).toBe("/copy");
    expect(completeSlash("/mo")).toBe("/model ");
    expect(completeSlash("/b")).toBe("/b");
    expect(completeSlash("/br")).toBe("/branch");
    expect(completeSlash("hello")).toBeUndefined();
  });
});
