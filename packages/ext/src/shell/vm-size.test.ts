/**
 * VM size per home (phase 4 slice 4), ext side: the home's stored size
 * reaches the VM spec (`vmSpecOf` — defaults 1 CPU / 512 MiB when a legacy
 * embedder supplies none); the spec fingerprint — SIZE plus allowlist —
 * drives the applied marker, so an edited size recreates the VM at its
 * NEXT START (`specDrift`); and the home scope's `vm` rides `homeWorldOf`
 * to the backend options. No VM runtime is touched.
 */
import { describe, expect, it } from "vite-plus/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeWorldOf } from "../plugins/bash.ts";
import type { HomeScope } from "../plugins/vault.ts";
import {
  clearAppliedFingerprint,
  markAppliedFingerprint,
  readAppliedFingerprint,
  specDrift,
  vmSpecFingerprint,
} from "./net-policy.ts";
import { vmSpecOf, type SandboxBackendOptions } from "./sandbox-backend.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-vm-size-ext-"));

describe("vmSpecOf (what reaches the builder)", () => {
  it("defaults to 1 CPU / 512 MiB when the home stores no size", () => {
    expect(vmSpecOf({ name: "ultiv-x" })).toMatchObject({
      cpus: 1,
      memoryMiB: 512,
      allowlist: [],
      mounts: [],
    });
  });

  it("carries the home's stored size and allowlist verbatim", () => {
    const options: SandboxBackendOptions = {
      name: "ultiv-x",
      vm: { cpus: 4, memoryMiB: 2048 },
      netAllowlist: ["api.example.com"],
    };
    expect(vmSpecOf(options)).toMatchObject({
      cpus: 4,
      memoryMiB: 2048,
      allowlist: ["api.example.com"],
    });
  });

  it("covers the image and every mount (fix: a changed mount or image recreates the VM)", () => {
    const base: SandboxBackendOptions = { name: "ultiv-x", image: "img-a" };
    const fp = (options: SandboxBackendOptions) => vmSpecFingerprint(vmSpecOf(options));
    expect(fp({ ...base, image: "img-b" })).not.toBe(fp(base));
    const ro = { ...base, orgShared: { hostDir: "/s/org", gid: 9, readOnly: true } };
    expect(fp(ro)).not.toBe(fp(base));
    expect(fp({ ...ro, orgShared: { ...ro.orgShared, readOnly: false } })).not.toBe(fp(ro));
    expect(fp({ ...base, sharedStore: "/s/d1" })).not.toBe(fp(base));
    expect(
      fp({ ...base, teamShared: { parentDir: "/s/_team", teams: [], users: [] } as never }),
    ).not.toBe(fp(base));
    expect(vmSpecOf(ro).mounts).toEqual(["/home/org-shared=/s/org:ro"]);
  });
});

describe("the spec fingerprint (size AND policy, one marker)", () => {
  const spec = { cpus: 2, memoryMiB: 1024, allowlist: ["api.example.com", "*.pypi.org"] };

  it("changes when the size changes — the recreate trigger for an edit", () => {
    expect(vmSpecFingerprint({ ...spec, cpus: 4 })).not.toBe(vmSpecFingerprint(spec));
    expect(vmSpecFingerprint({ ...spec, memoryMiB: 512 })).not.toBe(vmSpecFingerprint(spec));
  });

  it("is allowlist-normalized: order and case do not matter", () => {
    expect(vmSpecFingerprint({ ...spec, allowlist: ["*.pypi.org", "API.example.com"] })).toBe(
      vmSpecFingerprint(spec),
    );
  });

  it("drives the applied marker: drift only after a change, none after re-marking", () => {
    const file = join(scratch, "ultiv-x.json");
    const name = "ultiv-x";
    // A VM whose marker is missing (first boot, or a legacy marker from
    // before the size joined the spec) counts as drifted.
    expect(specDrift(name, spec, file)).toBe(true);
    markAppliedFingerprint(name, vmSpecFingerprint(spec), file);
    expect(specDrift(name, spec, file)).toBe(false);
    // The owner shrinks the VM: the NEXT START recreates it.
    const shrunk = { ...spec, memoryMiB: 512 };
    expect(specDrift(name, shrunk, file)).toBe(true);
    markAppliedFingerprint(name, vmSpecFingerprint(shrunk), file);
    expect(specDrift(name, shrunk, file)).toBe(false);
    expect(readAppliedFingerprint(name, file)).toBe(vmSpecFingerprint(shrunk));
    clearAppliedFingerprint(name, file);
    expect(specDrift(name, shrunk, file)).toBe(true);
  });
});

describe("the home scope's vm rides to the backend options", () => {
  it("homeWorldOf passes the stored size through, and omits it when absent", () => {
    const home: HomeScope = { dir: "/h/_home/org", vm: { cpus: 2, memoryMiB: 1024 } };
    expect(homeWorldOf("/h/owner-a/bot-a", home).vm).toEqual({ cpus: 2, memoryMiB: 1024 });
    expect(homeWorldOf("/h/owner-a/bot-a", { dir: "/h/_home/org" }).vm).toBeUndefined();
  });
});
