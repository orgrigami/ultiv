import { describe, expect, it } from "vite-plus/test";
import type { ProfileInfo } from "@ultiv/contracts";
import { defaultPolicies } from "./docs.ts";
import { patchedProfile, validatePatch } from "./update.ts";

const row = (policies: ProfileInfo["policies"]): ProfileInfo => ({
  id: "p1",
  owner: "harry",
  name: "Scout",
  description: "",
  persona: "",
  timezone: "Asia/Jakarta",
  model: null,
  toolAllowlist: null,
  policies,
  createdAt: 0,
  archivedAt: null,
});

describe("Profile policy patches", () => {
  it("defaults carry the manual approval mode", () => {
    expect(defaultPolicies().approvalMode).toBe("manual");
  });

  it("a policies patch merges per key, not wholesale", () => {
    const current = row({ ...defaultPolicies(), autoApprove: ["now"] });
    // What a chat-box switcher sends: only the mode key (partial object).
    const next = patchedProfile(current, {
      policies: { approvalMode: "yolo" },
    } as Parameters<typeof patchedProfile>[1]);
    // The switched key changed; the untouched keys survived the patch.
    expect(next.policies.approvalMode).toBe("yolo");
    expect(next.policies.autoApprove).toEqual(["now"]);
    expect(next.policies.canInitiate).toEqual(["*"]);
    expect(next.policies.approvalTimeout).toBe("deny");
    expect(next.policies.dailyTurnBudget).toBeNull();
    expect(next.policies.memoryKeeper).toBe(false);
  });

  it("an empty policies patch leaves every key alone", () => {
    const current = row({ ...defaultPolicies(), autoApprove: ["now"], approvalMode: "jev" });
    const next = patchedProfile(current, { description: "new role" });
    expect(next.policies).toEqual(current.policies);
  });

  it("a chat-box switch patches just the mode", () => {
    const current = row(defaultPolicies());
    const next = patchedProfile(current, {
      policies: { ...defaultPolicies(), approvalMode: "manual" },
    });
    expect(next.policies.approvalMode).toBe("manual");
  });

  it("a sandbox patch flips only the sandbox key", () => {
    const current = row({ ...defaultPolicies(), autoApprove: ["bash"] });
    const next = patchedProfile(
      current,
      // A partial policies object, like the bot dialog sends.
      { policies: { sandbox: false } } as Parameters<typeof patchedProfile>[1],
    );
    expect(next.policies.sandbox).toBe(false);
    expect(next.policies.autoApprove).toEqual(["bash"]);
    expect(next.policies.approvalMode).toBe("manual");
  });

  it("validatePatch rejects an unknown approval mode", () => {
    let reason = "";
    try {
      validatePatch({
        policies: { ...defaultPolicies(), approvalMode: "chaos" as never },
      });
    } catch (error) {
      reason = (error as { reason?: string }).reason ?? "";
    }
    expect(reason).toBe("unknown approval mode: chaos");
    // The three literals pass.
    expect(() =>
      validatePatch({ policies: { ...defaultPolicies(), approvalMode: "jev" } }),
    ).not.toThrow();
    expect(() =>
      validatePatch({ policies: { ...defaultPolicies(), approvalMode: "yolo" } }),
    ).not.toThrow();
  });

  it("validatePatch rejects a model the catalog does not list", () => {
    const known = (ref: string) => ref === "kenari/deepseek-v4-1-flash";
    expect(() =>
      validatePatch({ model: { id: "kenari/deepseek-v4-1-flash", effort: "" } }, known),
    ).not.toThrow();
    expect(() => validatePatch({ model: { id: "acme/nope", effort: "" } }, known)).toThrow();
  });

  it("bounds and shape-checks autoApprove entries (the hook compiles them synchronously)", () => {
    const base = { ...defaultPolicies(), autoApprove: ["bash:git *"] };
    expect(() => validatePatch({ policies: base })).not.toThrow();
    const reasonOf = (run: () => void): string => {
      try {
        run();
        return "";
      } catch (error) {
        return (error as { reason?: string }).reason ?? "";
      }
    };
    expect(
      reasonOf(() =>
        validatePatch({
          policies: {
            ...base,
            autoApprove: Array.from({ length: 33 }, (_, i) => `tool${i}`),
          },
        }),
      ),
    ).toMatch(/too many autoApprove entries/);
    expect(
      reasonOf(() => validatePatch({ policies: { ...base, autoApprove: ["x".repeat(201)] } })),
    ).toMatch(/autoApprove entry too long/);
    // A pathological glob chain would backtrack the synchronous gate.
    expect(
      reasonOf(() => validatePatch({ policies: { ...base, autoApprove: ["bash:*a*a*a*a*a*b"] } })),
    ).toMatch(/invalid autoApprove entry/);
    expect(
      reasonOf(() => validatePatch({ policies: { ...base, autoApprove: ["evil:x:git *"] } })),
    ).toBe(""); // a pattern for a colon-named tool is expressible explicitly
  });
});
