/** The principal seam: one account, reserved labels never pass as it. */
import { describe, expect, it } from "vite-plus/test";
import { AGENT_OWNER } from "@spriessen/mind";
import { OWNER_ID, ownerOf, principalForLabel, principalOfAccount } from "./identity.ts";

describe("identity", () => {
  it("the signed-in account is the one owner label", () => {
    expect(OWNER_ID).toBe("owner");
    expect(principalOfAccount()).toEqual({ kind: "user", id: OWNER_ID });
    expect(ownerOf(principalOfAccount())).toBe(OWNER_ID);
  });

  it("a reserved label never passes as the account", () => {
    expect(AGENT_OWNER).toBe("agent");
    expect(ownerOf(principalForLabel("agent"))).toBe("guest");
    expect(ownerOf(principalForLabel(""))).toBe("guest");
    expect(ownerOf(principalForLabel("owner-a"))).toBe("owner-a");
  });
});
