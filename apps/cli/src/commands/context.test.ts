/**
 * One naming rule for every command and the TUI: a bot by id, name or a
 * unique start of its name; a chat or task by id or a unique start of it
 * (at least 4 characters). An unclear name says what it could be. Bulk
 * approve leaves the cards that are asked every time on purpose.
 */
import type { ProfileInfo } from "@spriessen/contracts";
import { describe, expect, it } from "vite-plus/test";
import { matchBot, matchId } from "./context.ts";
import { needsOwnLook } from "./line.ts";

const bots = [
  { id: "p1", name: "Wren" },
  { id: "p2", name: "Willow" },
  { id: "p3", name: "Ash" },
] as ProfileInfo[];

describe("naming things", () => {
  it("finds a bot by id, name in any case, or a unique start", () => {
    expect(matchBot(bots, "p3").name).toBe("Ash");
    expect(matchBot(bots, "wren").name).toBe("Wren");
    expect(matchBot(bots, "wil").name).toBe("Willow");
    expect(() => matchBot(bots, "w")).toThrow(/could be any of Wren, Willow/);
    expect(() => matchBot(bots, "Oak")).toThrow(/No bot is called Oak \(bots: Wren, Willow, Ash\)/);
  });

  it("finds an id by its start, never by a too-short or shared one", () => {
    const rows = [{ id: "abcd1234" }, { id: "abcd9999" }, { id: "ffff0000" }];
    expect(matchId(rows, "ffff", "chat", "x").id).toBe("ffff0000");
    expect(matchId(rows, "abcd1234", "chat", "x").id).toBe("abcd1234");
    expect(() => matchId(rows, "abcd", "chat", "x")).toThrow(/More than one chat/);
    expect(() => matchId(rows, "fff", "chat", "x")).toThrow(/No chat has the id fff/);
  });
});

describe("approve --all", () => {
  it("leaves floors and beyond-VM scripts for their own look", () => {
    expect(needsOwnLook({ name: "web_fetch", input: {} })).toBe(false);
    expect(needsOwnLook({ name: "bash", input: { script: "ls" } })).toBe(false);
    expect(needsOwnLook({ name: "bash", input: { script: "ls", target: "host" } })).toBe(true);
    expect(needsOwnLook({ name: "secret_request", input: {} })).toBe(true);
    expect(needsOwnLook({ name: "connector_add", input: {} })).toBe(true);
  });
});
