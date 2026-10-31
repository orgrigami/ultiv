import { describe, expect, it } from "vite-plus/test";
import type { CredentialBinding, ProfileInfo } from "@spreissen/contracts";
import { allowlistGaps, bindingSummary, draftOf, hostsOf, inputOf } from "./binding-text.ts";

const binding: CredentialBinding = {
  adapter: "http",
  hosts: ["api.stripe.com", "https://hooks.x.com/in"],
  methods: ["GET", "POST"],
  auth: { placement: "header", name: "X-Api-Key", prefix: "Token " },
  profiles: ["eve"],
  allowLocalhostHttp: false,
  itemId: "i1",
  approvedHosts: [],
  updatedAt: 0,
};

describe("binding text", () => {
  it("round-trips a binding through the draft", () => {
    const { itemId: _i, approvedHosts: _a, updatedAt: _u, ...input } = binding;
    expect(inputOf(draftOf(binding))).toEqual(input);
  });

  it("splits hosts on lines and commas and drops a name the placement ignores", () => {
    expect(hostsOf(" a.com,\n\nb.com ")).toEqual(["a.com", "b.com"]);
    const draft = { ...draftOf(undefined), hosts: "a.com", name: "ignored", prefix: "x" };
    expect(inputOf(draft).auth).toEqual({ placement: "bearer" });
  });

  it("summarizes and flags bots whose allowlist leaves out http_request", () => {
    expect(bindingSummary(binding)).toBe("GET, POST · api.stripe.com +1");
    const profiles = [
      { id: "eve", toolAllowlist: ["bash"] },
      { id: "max", toolAllowlist: null },
      { id: "ann", toolAllowlist: ["http_request"] },
    ] as unknown as ProfileInfo[];
    expect(allowlistGaps(profiles, null).map((p) => p.id)).toEqual(["eve"]);
    expect(allowlistGaps(profiles, ["max"])).toEqual([]);
  });
});
