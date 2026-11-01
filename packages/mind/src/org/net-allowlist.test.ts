/**
 * The per-VM network allowlist (phase 4 slice 3), mind side: legacy rows
 * (stored before the field existed) read an EMPTY allowlist — the offline
 * default — never undefined; the org and department patches persist one;
 * and the home-scope resolver hands the RIGHT home's list to ext (the
 * org's for the org VM, the department's for its VM).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { commitOrg, homeScopeOfProfile, openMind, readOrgState } from "@spriessen/mind";
import { netAllowlistProblem } from "@spriessen/contracts";
import type { OrgState } from "@spriessen/contracts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-net-allowlist-"));
afterAll(() => handle?.close().then(() => rmSync(scratch, { recursive: true, force: true })));

type MindHandle = Awaited<ReturnType<typeof openMind>>;

const handle: MindHandle = await openMind({ storage: new MemoryStorage() });
const mind = handle.mind;
const owner = "owner-a";

describe("the allowlist default and its storage", () => {
  it("a legacy row without the field reads an empty allowlist (offline default)", async () => {
    await mind.org.ensureOrg(owner, "Personal", true);
    await mind.org.createDepartment({ name: "Ops" }, owner);
    // Rewrite both rows WITHOUT the field, the way slice 2d stored them.
    await commitOrg(mind.converse, (draft: OrgState) => {
      const org = draft.org;
      if (org !== null) {
        const { netAllowlist: _dropped, ...rest } = org;
        draft.org = rest as typeof org;
      }
      draft.departments = draft.departments.map(({ netAllowlist: _d, ...rest }) => {
        void _d;
        return rest as (typeof draft.departments)[number];
      });
    });
    const state = await readOrgState(mind.converse);
    expect(state.org?.netAllowlist).toEqual([]);
    expect(state.departments[0]?.netAllowlist).toEqual([]);
  });

  it("the org patch persists an allowlist; clearing it stores an empty list", async () => {
    const org = await mind.org.updateOrg({ netAllowlist: ["api.example.com", "example.org"] });
    expect(org.netAllowlist).toEqual(["api.example.com", "example.org"]);
    const cleared = await mind.org.updateOrg({ netAllowlist: [] });
    expect(cleared.netAllowlist).toEqual([]);
  });

  it("a department is created with its allowlist and patches its own", async () => {
    const made = await mind.org.createDepartment(
      { name: "Lab", netAllowlist: ["*.pypi.org"] },
      owner,
    );
    expect(made.netAllowlist).toEqual(["*.pypi.org"]);
    const patched = await mind.org.updateDepartment(made.id, {
      netAllowlist: ["pypi.org", "files.pythonhosted.org"],
    });
    expect(patched.netAllowlist).toEqual(["pypi.org", "files.pythonhosted.org"]);
    // The other department is untouched.
    const state = await readOrgState(mind.converse);
    expect(state.departments.find((row) => row.id !== made.id)?.netAllowlist).toEqual([]);
  });

  it("the home scope carries the right home's list to ext", async () => {
    const state = await readOrgState(mind.converse);
    const lab = state.departments.find((row) => row.name === "Lab");
    expect(lab).toBeDefined();
    await mind.org.updateOrg({ netAllowlist: ["api.example.com"] });
    await mind.profiles.create(owner, { name: "Scout", onboard: false });
    await mind.profiles.create(owner, {
      name: "Digger",
      departmentId: lab?.id ?? null,
      onboard: false,
    });
    const profiles = await mind.profiles.list(owner);
    const orgBot = profiles.find((row) => row.name === "Scout");
    const deptBot = profiles.find((row) => row.name === "Digger");
    const orgScope = await homeScopeOfProfile(mind.converse, scratch)(owner, orgBot as never);
    const deptScope = await homeScopeOfProfile(mind.converse, scratch)(owner, deptBot as never);
    expect(orgScope?.netAllowlist).toEqual(["api.example.com"]);
    expect(deptScope?.netAllowlist).toEqual(["pypi.org", "files.pythonhosted.org"]);
  });
});

describe("netAllowlistProblem (the REST validator)", () => {
  it("accepts hostnames and *.suffix forms", () => {
    expect(netAllowlistProblem(["api.example.com", "*.pypi.org"])).toBeNull();
    expect(netAllowlistProblem([])).toBeNull();
  });

  it("refuses junk, uppercase, bare dots and oversized lists", () => {
    expect(netAllowlistProblem("api.example.com")).not.toBeNull();
    expect(netAllowlistProblem(["https://api.example.com"])).not.toBeNull();
    expect(netAllowlistProblem(["Api.example.com"])).not.toBeNull();
    expect(netAllowlistProblem([".."])).not.toBeNull();
    expect(netAllowlistProblem(["*"])).not.toBeNull();
    expect(
      netAllowlistProblem(Array.from({ length: 65 }, (_, i) => `h${i}.example.com`)),
    ).not.toBeNull();
  });
});
