/** The principal seam: reserved owner labels resolve to guest. */
import { describe, expect, it } from "vite-plus/test";
import { AGENT_OWNER } from "@ultiv/mind";
import { ownerOf, principalFromHeaders, principalFromRequest } from "./identity.ts";

describe("principalFromHeaders", () => {
  it("a named principal keeps its id", () => {
    expect(principalFromHeaders((n) => (n === "x-ultiv-user" ? "harry" : undefined))).toEqual({
      kind: "user",
      id: "harry",
    });
  });

  it("empty or missing means guest", () => {
    expect(principalFromHeaders(() => undefined)).toEqual({ kind: "guest" });
    expect(principalFromHeaders((n) => (n === "x-ultiv-user" ? "  " : undefined))).toEqual({
      kind: "guest",
    });
  });

  it("a principal may not NAME itself a reserved owner label", () => {
    // `agent` is the sentinel bot-spawned task rows are filed under; a
    // caller claiming it would pass every "own rows" check on those rows.
    expect(AGENT_OWNER).toBe("agent");
    const principal = principalFromHeaders((n) => (n === "x-ultiv-user" ? "agent" : undefined));
    expect(ownerOf(principal)).toBe("guest");
    const fromRequest = principalFromRequest({ headers: { "x-ultiv-user": "agent" } });
    expect(ownerOf(fromRequest)).toBe("guest");
  });
});
