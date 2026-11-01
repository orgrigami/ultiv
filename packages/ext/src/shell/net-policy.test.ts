/**
 * The per-VM network policy (phase 4 slice 3), unit level: the pure
 * construction from a home's allowlist to a microsandbox `NetworkPolicy`
 * (plain objects against the SDK's published shape — no native module
 * load), the applied-fingerprint marker that tells `ensureVm` when a VM
 * must be RECREATED (the policy is create-time-only in the SDK), and the
 * home-scope passthrough that carries the list from the mind to the VM
 * options.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { homeWorldOf } from "../plugins/bash.ts";
import type { HomeScope } from "../plugins/vault.ts";
import {
  allowlistFingerprint,
  allowlistNetwork,
  allowlistPolicy,
  clearAppliedFingerprint,
  DENY_ALL,
  markAppliedFingerprint,
  normalizeAllowlist,
  readAppliedFingerprint,
} from "./net-policy.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-net-policy-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("allowlistPolicy (allowlist -> NetworkPolicy)", () => {
  it("an absent or empty allowlist is the deny-everything default", () => {
    expect(allowlistPolicy([])).toEqual(DENY_ALL);
    expect(allowlistPolicy([])).toEqual({
      defaultEgress: "deny",
      defaultIngress: "deny",
      rules: [],
    });
  });

  it("allowlists exactly the named hosts, deny by default", () => {
    const policy = allowlistPolicy(["api.example.com"]);
    expect(policy.defaultEgress).toBe("deny");
    expect(policy.defaultIngress).toBe("deny");
    // The DNS rule the names need, then one allow rule per host.
    expect(policy.rules).toHaveLength(2);
    expect(policy.rules[0]).toMatchObject({
      direction: "egress",
      // DNS only to the VM resolver (the host group), never port 53 anywhere.
      destination: { kind: "group", group: "host" },
      ports: [{ start: 53, end: 53 }],
      action: "allow",
    });
    expect(policy.rules[1]).toMatchObject({
      direction: "egress",
      destination: { kind: "domain", domain: "api.example.com" },
      action: "allow",
    });
  });

  it("a *.suffix entry becomes a domain-suffix rule", () => {
    const policy = allowlistPolicy(["*.pypi.org"]);
    expect(policy.rules[1]).toMatchObject({
      destination: { kind: "domainSuffix", suffix: "pypi.org" },
      action: "allow",
    });
  });

  it("normalizes: trims, lowercases, dedupes, keeps a stable order", () => {
    expect(normalizeAllowlist(["Example.COM ", "", "example.com"])).toEqual(["example.com"]);
    expect(allowlistPolicy(["b.example.com", "a.example.com"])).toEqual(
      allowlistPolicy(["a.example.com", "b.example.com"]),
    );
  });

  it("open=true allows ALL egress and ignores the allowlist, ingress still denied", () => {
    const policy = allowlistPolicy(["api.example.com"], true);
    expect(policy).toEqual({ defaultEgress: "allow", defaultIngress: "deny", rules: [] });
    // The owner opt-in must be a distinct policy from any allowlist.
    expect(policy).not.toEqual(allowlistPolicy(["api.example.com"]));
    expect(allowlistPolicy([], true)).toEqual(policy);
  });
});

describe("the applied-fingerprint marker (a change recreates the VM)", () => {
  const name = "ultiv-probe";
  const file = join(scratch, "marker.json");

  it("an unmarked VM reads as needing the stored policy applied", () => {
    expect(readAppliedFingerprint(name, file)).toBeUndefined();
  });

  it("marking records the fingerprint; a different list no longer matches", () => {
    const first = allowlistFingerprint(["api.example.com"]);
    markAppliedFingerprint(name, first, file);
    expect(readAppliedFingerprint(name, file)).toBe(first);
    expect(readAppliedFingerprint(name, file)).not.toBe(allowlistFingerprint([]));
    // Order and case do not change the fingerprint; membership does.
    expect(allowlistFingerprint(["API.example.com"])).toBe(first);
    expect(allowlistFingerprint(["api.example.com", "example.org"])).not.toBe(first);
  });

  it("clearing drops the marker, as destroying the VM does", () => {
    clearAppliedFingerprint(name, file);
    expect(readAppliedFingerprint(name, file)).toBeUndefined();
  });
});

describe("allowlistNetwork (the network() seam the VM boots with)", () => {
  it("applies the home's policy and bypasses TLS interception", () => {
    const calls: string[] = [];
    const network = {
      policy: (_policy: unknown): unknown => {
        calls.push("policy");
        return network;
      },
      tls: (configure: (tls: { bypass: (pattern: string) => unknown }) => unknown): unknown => {
        calls.push("tls");
        return configure({ bypass: (pattern) => calls.push(`bypass:${pattern}`) as unknown });
      },
    };
    allowlistNetwork(network as never, ["api.example.com"]);
    expect(calls).toEqual(["policy", "tls", "bypass:*"]);
  });
});

describe("the home-scope passthrough (mind -> ext)", () => {
  it("carries the home's allowlist into the VM world", () => {
    const home = {
      dir: "/x/_home/org",
      netAllowlist: ["api.example.com"],
    } satisfies HomeScope;
    expect(homeWorldOf("/x/owner/bot", home).netAllowlist).toEqual(["api.example.com"]);
  });

  it("an absent allowlist stays absent (the backend then boots offline)", () => {
    const home = { dir: "/x/_home/org" } satisfies HomeScope;
    expect(homeWorldOf("/x/owner/bot", home).netAllowlist).toBeUndefined();
  });

  it("carries netOpen through, and a flipped open flag changes the spec fingerprint", async () => {
    const { vmSpecFingerprint } = await import("./net-policy.ts");
    const home = { dir: "/x/_home/org", netOpen: true } satisfies HomeScope;
    expect(homeWorldOf("/x/owner/bot", home).netOpen).toBe(true);
    const base = { cpus: 1, memoryMiB: 512, allowlist: ["api.example.com"] };
    expect(vmSpecFingerprint({ ...base, open: true })).not.toBe(vmSpecFingerprint(base));
    expect(vmSpecFingerprint({ ...base, open: true })).toBe(
      vmSpecFingerprint({ ...base, open: true }),
    );
  });
});
