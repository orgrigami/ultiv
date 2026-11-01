/**
 * The per-VM network policy (phase 4 slice 3). DEFAULT: NO network — the
 * org VM and every department VM boot with a deny-everything microsandbox
 * `NetworkPolicy`. A home's stored allowlist (named hosts, on the org or
 * department row) opens exactly those hosts: one egress allow rule per
 * entry (`*.suffix` becomes a domain-suffix rule) plus the DNS egress the
 * names need; raw addresses, other ports' hosts and every ingress stay
 * denied. The policy is create-time-only in microsandbox 0.7.11
 * (`modify()` has no policy field and `restart()` reuses the stored
 * config), so an allowlist edit reaches a VM by RECREATING it at its next
 * use — the applied fingerprint file beside the sandbox state tells
 * `ensureVm` when the stored policy no longer matches. Pure construction
 * here: plain `Rule` objects against the SDK's published shape, no native
 * module load, so the suite tests it directly.
 */
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { artifactsDir } from "../plugins/artifacts.ts";

/**
 * The `microsandbox` policy shapes (published plain interfaces — see
 * `policy/types.d.ts`). Type-only: the objects here are handed to
 * `Sandbox.builder().networkPolicy(...)` verbatim.
 */
import type { Destination, NetworkPolicy, PortRange, Rule } from "microsandbox";

/** The default for every VM: deny egress and ingress, no rules. */
export const DENY_ALL: NetworkPolicy = {
  defaultEgress: "deny",
  defaultIngress: "deny",
  rules: [],
};

const allowRule = (
  destination: Destination,
  protocols: Rule["protocols"],
  ports: PortRange[],
): Rule => ({
  direction: "egress",
  destination,
  protocols,
  ports,
  action: "allow",
});

/** Trim, lowercase, drop empties and duplicates; stable order for fingerprints. */
export const normalizeAllowlist = (hosts: readonly string[]): string[] =>
  [...new Set(hosts.map((host) => host.trim().toLowerCase()).filter((host) => host !== ""))].sort();

/**
 * The policy for one home's allowlist: deny by default, allow egress to the
 * named hosts (a `*.suffix` entry covers its subdomains), and — only when
 * at least one host is listed — the DNS lookups those names need.
 */
export const allowlistPolicy = (hosts: readonly string[], open = false): NetworkPolicy => {
  // Full network access (owner opt-in): every egress allowed, ingress still
  // denied. The allowlist is ignored; the UI and docs say isolation is off.
  if (open) return { defaultEgress: "allow", defaultIngress: "deny", rules: [] };
  const names = normalizeAllowlist(hosts);
  if (names.length === 0) return DENY_ALL;
  // DNS only to the VM's own resolver: microsandbox points the guest's
  // resolv.conf at the host gateway and forwards from there, so the SDK's
  // `Rule.allowDns()` destination — the `host` group — is the one resolver
  // a guest actually uses. Port 53 to any OTHER address stays denied (no
  // DNS tunnelling to an outside resolver).
  const dns: Rule = allowRule(
    { kind: "group", group: "host" },
    ["udp", "tcp"],
    [{ start: 53, end: 53 }],
  );
  const rules: Rule[] = names.map((host) =>
    host.startsWith("*.")
      ? allowRule({ kind: "domainSuffix", suffix: host.slice(2) }, [], [])
      : allowRule({ kind: "domain", domain: host }, [], []),
  );
  return { defaultEgress: "deny", defaultIngress: "deny", rules: [dns, ...rules] };
};

/** A short stable fingerprint of the effective allowlist. */
export const allowlistFingerprint = (hosts: readonly string[]): string =>
  createHash("sha256")
    .update(JSON.stringify(normalizeAllowlist(hosts)))
    .digest("hex")
    .slice(0, 16);
/**
 * The whole create-time spec of one home's VM (slice 4): its stored SIZE
 * (cpus, memoryMiB) plus its network allowlist. Both are create-time-only
 * in the SDK, so ONE fingerprint covers both: any change recreates the VM
 * at its next use (the applied-fingerprint marker).
 */
export interface VmSpec {
  readonly cpus: number;
  readonly memoryMiB: number;
  readonly allowlist: readonly string[];
  /** Full network access: the allowlist is ignored, all egress allowed. */
  readonly open?: boolean;
  /** The OCI image the VM was created from (create-time-only too). */
  readonly image?: string;
  /** The declared volumes, `guest=host:ro|rw`, sorted (create-time-only too). */
  readonly mounts?: readonly string[];
}

/** A short stable fingerprint of the whole spec a VM was created with. */
export const vmSpecFingerprint = (spec: VmSpec): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        cpus: spec.cpus,
        memoryMiB: spec.memoryMiB,
        allowlist: normalizeAllowlist(spec.allowlist),
        open: spec.open === true,
        image: spec.image ?? null,
        mounts: [...(spec.mounts ?? [])].sort(),
      }),
    )
    .digest("hex")
    .slice(0, 16);

/**
 * Whether a VM's stored spec has drifted from what it was CREATED with:
 * true means the VM must be removed and recreated at its next use.
 */
export const specDrift = (sandboxName: string, spec: VmSpec, file?: string): boolean =>
  readAppliedFingerprint(sandboxName, file) !== vmSpecFingerprint(spec);

/**
 * The `network(...)` configuration EVERY VM gets: the home's policy, plus
 * TLS interception bypassed (`bypass("*")`). Probe-verified on this host:
 * without the bypass the interception proxy RESETS the TLS handshake of
 * allowlisted hosts (it has no upstream trust material), while a denied
 * host gets an explicit 403. With it, bots' TLS to allowlisted hosts stays
 * end to end — no CA is installed in the guest — and the deny still holds.
 * Typed structurally so the probe can reuse it without the native module.
 */
export const allowlistNetwork = (
  network: {
    policy: (policy: NetworkPolicy) => unknown;
    tls: (configure: (tls: { bypass: (pattern: string) => unknown }) => unknown) => unknown;
  },
  hosts: readonly string[],
  open = false,
): unknown => {
  const withPolicy = network.policy(allowlistPolicy(hosts, open)) as typeof network;
  return withPolicy.tls((tls: { bypass: (pattern: string) => unknown }) => tls.bypass("*"));
};

/** Where the last policy a VM was CREATED with is recorded. */
const markerPath = (sandboxName: string): string =>
  join(
    artifactsDir(),
    "..",
    "sandbox-netpolicy",
    `${createHash("sha256").update(sandboxName).digest("hex").slice(0, 12)}.json`,
  );

/** The fingerprint the VM was last created with (undefined: never recorded). */
export const readAppliedFingerprint = (sandboxName: string, file?: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file ?? markerPath(sandboxName), "utf8"));
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** Records the fingerprint a VM now carries (best effort, never throws). */
export const markAppliedFingerprint = (
  sandboxName: string,
  fingerprint: string,
  file?: string,
): void => {
  const path = file ?? markerPath(sandboxName);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(fingerprint));
  } catch {
    // A missing marker only costs one extra recreate at the next boot.
  }
};

/** Drops the marker (with the VM itself). */
export const clearAppliedFingerprint = (sandboxName: string, file?: string): void => {
  rmSync(file ?? markerPath(sandboxName), { force: true });
};
