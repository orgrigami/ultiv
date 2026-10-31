/**
 * The one permission decision: the account reaches its own rows and the
 * owner-level surfaces and the host capability; nothing else does, the
 * `agent` sentinel never acts, and an absent label is nobody.
 */
import { describe, expect, it } from "vite-plus/test";
import { can } from "./can.ts";

describe("can", () => {
  it("the account acts on its own rows, and nobody else's", () => {
    expect(can("owner", "view", { type: "chat", owner: "owner", id: "s1" })).toBe(true);
    expect(can("owner", "change", { type: "bot", owner: "owner", id: "b1" })).toBe(true);
    expect(can("owner", "remove", { type: "record", owner: "guest", id: "r1" })).toBe(false);
    expect(can("owner", "view", { type: "artifact", owner: "someone-else", id: "a1" })).toBe(false);
    expect(can("someone-else", "view", { type: "chat", owner: "owner", id: "s1" })).toBe(false);
  });

  it("owner-level surfaces and the host capability belong to the account", () => {
    expect(can("owner", "view", { type: "account" })).toBe(true);
    expect(can("owner", "change", { type: "host" })).toBe(true);
    expect(can("guest", "view", { type: "account" })).toBe(false);
    expect(can("guest", "change", { type: "host" })).toBe(false);
    expect(can("someone-else", "change", { type: "host" })).toBe(false);
  });

  it("reserved and empty labels never act", () => {
    expect(can("agent", "view", { type: "chat", owner: "agent", id: "t1" })).toBe(false);
    expect(can("", "view", { type: "account" })).toBe(false);
    expect(can("agent", "change", { type: "host" })).toBe(false);
  });
});
