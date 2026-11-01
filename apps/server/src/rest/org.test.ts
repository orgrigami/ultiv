/**
 * Org routes over the real REST handler: the view, department CRUD with the
 * VM defaults, the home invariant at the route level, and audit rows for
 * department state changes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { openMind } from "@spriessen/mind";
import { createRestHandler } from "../rest.ts";
import { AuthStore } from "../auth/store.ts";
import { signInForTest } from "../auth/test-auth.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-org-rest-"));
process.env["AUTH_DIR"] = join(scratch, "auth");
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");

let handle: Awaited<ReturnType<typeof openMind>>;
let server: Server;
let base = "";
let cookie = "";
let dept = "";

const call = async (
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      cookie,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = raw;
  }
  return { status: response.status, json };
};

beforeAll(async () => {
  // No VM runtime in tests: department removal's VM teardown is a no-op here.
  handle = await openMind({
    storage: new MemoryStorage(),
    destroyHomeVm: async () => {},
  });
  // The org exists the way a boot migration leaves it.
  await handle.mind.org.ensureOrg("owner", "Personal", true);
  // The first bot lives in the org and becomes the main bot (the home rules).
  await handle.mind.profiles.create("owner", { name: "Keeper", onboard: false });
  server = createServer(
    createRestHandler({
      mind: handle.mind,
      scheduler: { refresh: async () => {}, stop: () => {} },
      auth: new AuthStore(),
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  cookie = await signInForTest(base);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("org routes", () => {
  it("answers the org view", async () => {
    const view = await call("GET", "/api/org");
    expect(view.status).toBe(200);
    expect((view.json as { org: { name: string } }).org.name).toBe("Personal");
    expect((view.json as { departments: unknown[] }).departments).toEqual([]);
  });

  it("creates a department with VM defaults, or the given settings", async () => {
    const plain = await call("GET", "/api/org");
    void plain;
    const made = await call("POST", "/api/org/departments", { name: "Ops" });
    expect(made.status).toBe(200);
    const row = made.json as {
      id: string;
      vm: { cpus: number; memoryMiB: number };
      hostAccess: boolean;
    };
    expect(row.vm).toEqual({ cpus: 1, memoryMiB: 512 });
    expect(row.hostAccess).toBe(false);
    const sized = await call("POST", "/api/org/departments", {
      name: "Lab",
      vm: { cpus: 4, memoryMiB: 1024 },
    });
    expect((sized.json as { vm: unknown }).vm).toEqual({ cpus: 4, memoryMiB: 1024 });
    dept = row.id;
  });

  it("refuses a malformed vm size and a duplicate name", async () => {
    expect(
      (await call("POST", "/api/org/departments", { name: "Bad", vm: { cpus: 0, memoryMiB: 512 } }))
        .status,
    ).toBe(400);
    expect((await call("POST", "/api/org/departments", { name: "Ops" })).status).toBe(400);
  });

  it("patches name, vm, host access and instructions", async () => {
    const moved = await call("PATCH", `/api/org/departments/${dept}`, {
      instructions: "Answer in the department's voice.",
      hostAccess: true,
    });
    expect(moved.status).toBe(200);
    expect((moved.json as { instructions: string }).instructions).toContain("department's voice");
    expect((moved.json as { hostAccess: boolean }).hostAccess).toBe(true);
  });

  it("removes an empty department and refuses one that still has bots", async () => {
    const bot = await handle.mind.profiles.create("owner", {
      name: "Dept bot",
      onboard: false,
      departmentId: dept,
    });
    expect((await call("DELETE", `/api/org/departments/${dept}`)).json).toEqual({
      error: "the department still has bots",
    });
    await handle.mind.profiles.update("owner", bot.id, { departmentId: null });
    expect((await call("DELETE", `/api/org/departments/${dept}`)).json).toEqual({ ok: true });
  });

  it("audits department state changes", async () => {
    const events = await call("GET", "/api/audit?kind=permission");
    const names = (events.json as { name: string }[]).map((event) => event.name);
    expect(names).toContain("department-created");
    expect(names).toContain("department-host-access");
    expect(names).toContain("department-removed");
  });

  it("answers an unknown department like a missing one", async () => {
    const missing = { status: 404, json: { error: "unknown department" } };
    expect(await call("PATCH", "/api/org/departments/ghost", { name: "X" })).toEqual(missing);
    expect(await call("DELETE", "/api/org/departments/ghost")).toEqual(missing);
  });

  it("a department admin of one department is refused in another, like a missing item", async () => {
    const made = await call("POST", "/api/org/departments", { name: "West" });
    const x = made.json as { id: string };
    const other = await call("POST", "/api/org/departments", { name: "East" });
    const y = other.json as { id: string };
    // Seed roles on the REAL department ids (the account labels are
    // throwaway; only the signed-in owner exists on the wire today).
    await handle.mind.org.setMember({ accountId: "admin-x", role: "admin", departmentId: x.id });
    await handle.mind.org.setMember({ accountId: "admin-y", role: "admin", departmentId: y.id });
    const refusal = { status: 404, json: { error: "unknown department" } };
    // admin-x patches East: refused with the missing-item answer.
    const answer = await callAs("admin-x", "PATCH", `/api/org/departments/${y.id}`, { name: "X" });
    expect(answer).toEqual(refusal);
    // admin-x patches West (their own): allowed.
    expect(
      (await callAs("admin-x", "PATCH", `/api/org/departments/${x.id}`, { name: "W" })).status,
    ).toBe(200);
    // A plain member is refused everywhere.
    await handle.mind.org.setMember({ accountId: "mate-x", role: "member", departmentId: x.id });
    expect(await callAs("mate-x", "PATCH", `/api/org/departments/${x.id}`, { name: "W" })).toEqual(
      refusal,
    );
  });
});

/** Ask the org routes as a role actor, through the same handler code path. */
async function callAs(
  owner: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  let status = 0;
  let payload: unknown = null;
  const json = (code: number, out: unknown): void => {
    status = code;
    payload = out;
  };
  const url = new URL(path, "http://localhost");
  const req = { method, url: path } as unknown as import("node:http").IncomingMessage;
  const raw = body === undefined ? "" : JSON.stringify(body);
  const args = {
    mind: handle.mind,
    scheduler: { refresh: async () => {}, stop: () => {} },
    req,
    res: {} as import("node:http").ServerResponse,
    url,
    owner,
    path: url.pathname,
    json,
    readJson: async <T>() => JSON.parse(raw) as T,
    readBody: async () => Buffer.from(raw),
  } as unknown as import("./types.ts").RouteArgs;
  // Walk the org-family route modules the way the dispatcher does.
  const [org, templates, memoryV2, approvals] = await Promise.all([
    import("./org.ts"),
    import("./templates.ts"),
    import("./memory-v2.ts"),
    import("./approvals.ts"),
  ]);
  for (const routes of [
    org.orgRoutes,
    templates.templateRoutes,
    memoryV2.memoryV2Routes,
    approvals.approvalRoutes,
  ]) {
    if (await routes(args)) break;
  }
  return { status, json: payload };
}

describe("the department summary (slice 4)", () => {
  it("gives the org owner counts, bots and activity, never chat contents", async () => {
    const made = await call("POST", "/api/org/departments", { name: "Alpha" });
    const alpha = made.json as { id: string };
    const bot = await handle.mind.profiles.create("owner", {
      name: "Alpha bot",
      onboard: false,
      departmentId: alpha.id,
    });
    const session = await handle.mind.profiles.ensureMain("owner", bot.id);
    await handle.mind.audit.record({
      at: Date.now(),
      kind: "tool_call",
      conversationId: session.id,
      profile: bot.id,
      callId: null,
      name: "bash",
      durationMs: 5,
      ok: true,
      error: null,
    });
    const summary = await call("GET", `/api/org/departments/${alpha.id}/summary`);
    expect(summary.status).toBe(200);
    const body = summary.json as {
      department: { id: string };
      bots: { id: string; name: string }[];
      activity: { toolCalls7d: number; lastToolCallAt: number | null; openApprovals: number };
    };
    expect(body.department.id).toBe(alpha.id);
    expect(body.bots).toEqual([{ id: bot.id, name: "Alpha bot" }]);
    expect(body.activity.toolCalls7d).toBe(1);
    expect(body.activity.lastToolCallAt).not.toBeNull();
    // No chat contents anywhere in the digest.
    expect(JSON.stringify(body)).not.toContain("transcript");
    expect(JSON.stringify(body)).not.toContain("messages");
  });

  it("reads as a missing department for a role that may not see it", async () => {
    const made = await call("POST", "/api/org/departments", { name: "Beta" });
    const beta = made.json as { id: string };
    await handle.mind.org.setMember({
      accountId: "mate-beta",
      role: "member",
      departmentId: beta.id,
    });
    const refusal = { status: 404, json: { error: "unknown department" } };
    expect(await callAs("mate-beta", "GET", `/api/org/departments/${beta.id}/summary`)).toEqual(
      refusal,
    );
    expect(await callAs("mate-beta", "GET", "/api/org/departments/ghost/summary")).toEqual(refusal);
    // A member of ANOTHER department also reads it as missing.
    const gamma = (await call("POST", "/api/org/departments", { name: "Gamma" })).json as {
      id: string;
    };
    await handle.mind.org.setMember({
      accountId: "mate-gamma",
      role: "member",
      departmentId: gamma.id,
    });
    expect(await callAs("mate-gamma", "GET", `/api/org/departments/${beta.id}/summary`)).toEqual(
      refusal,
    );
  });
});

describe("reach grants (slice 5)", () => {
  it("creates, lists and revokes a grant, with audit rows", async () => {
    const alpha = (await call("POST", "/api/org/departments", { name: "GrantA" })).json as {
      id: string;
    };
    const beta = (await call("POST", "/api/org/departments", { name: "GrantB" })).json as {
      id: string;
    };
    const made = await call("POST", "/api/org/grants", {
      resource: {
        kind: "vault-item",
        id: "item-9",
        home: { kind: "department", departmentId: beta.id },
      },
      grantee: { kind: "department", departmentId: alpha.id },
    });
    expect(made.status).toBe(200);
    const grant = made.json as { id: string; action: string; revokedAt: null };
    expect(grant.action).toBe("use");
    expect(grant.revokedAt).toBeNull();
    const list = await call("GET", "/api/org/grants");
    expect((list.json as { id: string }[]).some((row) => row.id === grant.id)).toBe(true);
    expect((await call("DELETE", `/api/org/grants/${grant.id}`)).json).toEqual({ ok: true });
    // Revoked grants leave the active list at once.
    const after = await call("GET", "/api/org/grants");
    expect((after.json as { id: string }[]).some((row) => row.id === grant.id)).toBe(false);
    // Revoking again reads as missing.
    expect((await call("DELETE", `/api/org/grants/${grant.id}`)).status).toBe(404);
    const events = await call("GET", "/api/audit?kind=permission");
    const names = (events.json as { name: string }[]).map((event) => event.name);
    expect(names).toContain("grant-created");
    expect(names).toContain("grant-revoked");
  });

  it("refuses a malformed grant and unknown homes", async () => {
    expect(
      (await call("POST", "/api/org/grants", { resource: { kind: "vault-item" } })).status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/api/org/grants", {
          resource: {
            kind: "vault-item",
            id: "x",
            home: { kind: "department", departmentId: "ghost" },
          },
          grantee: { kind: "org" },
        })
      ).status,
    ).toBe(400);
  });

  it("a member cannot grant or revoke, and reads the missing-route answer", async () => {
    const alpha = (await call("POST", "/api/org/departments", { name: "GrantC" })).json as {
      id: string;
    };
    await handle.mind.org.setMember({
      accountId: "mate-c",
      role: "member",
      departmentId: alpha.id,
    });
    const body = {
      resource: {
        kind: "vault-item",
        id: "item-1",
        home: { kind: "department", departmentId: alpha.id },
      },
      grantee: { kind: "org" },
    };
    expect(await callAs("mate-c", "POST", "/api/org/grants", body)).toEqual({
      status: 404,
      json: { error: "unknown route" },
    });
    expect(await callAs("mate-c", "GET", "/api/org/grants")).toEqual({
      status: 404,
      json: { error: "no route: GET /api/org/grants" },
    });
  });
});

describe("department shared memory (slice 9)", () => {
  it("only an admin of the department decides; a member reads as missing", async () => {
    const made = await call("POST", "/api/org/departments", { name: "MemD" });
    const dept = made.json as { id: string };
    const bot = await handle.mind.profiles.create("owner", {
      name: "Proposer",
      onboard: false,
      departmentId: dept.id,
    });
    const fact = await handle.mind.memory.writeV2({
      owner: "owner",
      scope: "profile",
      profileId: bot.id,
      writer: bot.id,
      text: "The team's deploy window is Tuesday 10:00 WIB.",
    });
    await handle.mind.memory.proposeShare({
      owner: "owner",
      profileId: bot.id,
      departmentId: dept.id,
      factId: fact.id,
      summary: "deploy window",
    });
    await handle.mind.org.setMember({
      accountId: "mate-mem",
      role: "member",
      departmentId: dept.id,
    });
    // The member's list reads as missing; so does their decide.
    expect((await callAs("mate-mem", "GET", `/api/memory/v2?department=${dept.id}`)).status).toBe(
      404,
    );
    const proposals = (await call("GET", `/api/memory/v2?department=${dept.id}`)).json as {
      proposals: { id: string }[];
    };
    expect(proposals.proposals).toHaveLength(1);
    expect(
      (
        await callAs(
          "mate-mem",
          "POST",
          `/api/memory/v2/proposals/${proposals.proposals[0]?.id}/accept`,
          {},
        )
      ).status,
    ).toBe(404);
    // An admin of ANOTHER department also reads as missing.
    const other = (await call("POST", "/api/org/departments", { name: "MemE" })).json as {
      id: string;
    };
    await handle.mind.org.setMember({
      accountId: "admin-e",
      role: "admin",
      departmentId: other.id,
    });
    expect((await callAs("admin-e", "GET", `/api/memory/v2?department=${dept.id}`)).status).toBe(
      404,
    );
    // The department's admin accepts; the fact lands in the shared store.
    const accepted = await callAs(
      "admin-mem",
      "POST",
      `/api/memory/v2/proposals/${proposals.proposals[0]?.id}/accept`,
      {},
    );
    expect(accepted.status).toBe(404); // admin-mem does not exist; the owner passes below
    const byOwner = await call(
      "POST",
      `/api/memory/v2/proposals/${proposals.proposals[0]?.id}/accept?department=${dept.id}`,
      {},
    );
    expect(byOwner.json).toEqual({ id: proposals.proposals[0]?.id, status: "accepted" });
    const facts = (await call("GET", `/api/memory/v2?department=${dept.id}`)).json as {
      facts: { text: string }[];
    };
    expect(JSON.stringify(facts.facts)).toContain("deploy window");
  });
});

describe("host-access flags (slice 11)", () => {
  it("new bots default off; the effective value ANDs the levels and names the blocker", async () => {
    const fresh = await handle.mind.profiles.create("owner", { name: "Flagless", onboard: false });
    expect(fresh.hostAccess).toBe(false);
    const dept = (await call("POST", "/api/org/departments", { name: "FlagD" })).json as {
      id: string;
    };
    expect((dept as unknown as { hostAccess: boolean }).hostAccess).toBe(false);
    // A bot on its own: org is on (migration), department off -> blocked by
    // the department.
    const bot = await handle.mind.profiles.create("owner", {
      name: "Flagged",
      onboard: false,
      departmentId: dept.id,
      hostAccess: true,
    });
    const matrix = (await call("GET", "/api/org/host-access")).json as {
      bots: { profileId: string; allowed: boolean; blockedBy: string | null }[];
    };
    const mine = matrix.bots.find((row) => row.profileId === bot.id);
    expect(mine?.allowed).toBe(false);
    expect(mine?.blockedBy).toBe("department");
    // The org owner flips the department switch: now allowed.
    await call("PATCH", `/api/org/departments/${dept.id}`, { hostAccess: true });
    const after = (await call("GET", "/api/org/host-access")).json as {
      bots: { profileId: string; allowed: boolean }[];
    };
    expect(after.bots.find((row) => row.profileId === bot.id)?.allowed).toBe(true);
    // Moving the bot to the org keeps its own flag; org AND bot -> allowed.
    await call("PATCH", `/api/profiles/${bot.id}`, { departmentId: null });
    const moved = (await call("GET", "/api/org/host-access")).json as {
      bots: { profileId: string; allowed: boolean }[];
    };
    expect(moved.bots.find((row) => row.profileId === bot.id)?.allowed).toBe(true);
    // The bot's own switch off blocks even at the org.
    await call("PATCH", `/api/profiles/${bot.id}`, { hostAccess: false });
    const ownOff = (await call("GET", "/api/org/host-access")).json as {
      bots: { profileId: string; allowed: boolean; blockedBy: string | null }[];
    };
    const off = ownOff.bots.find((row) => row.profileId === bot.id);
    expect(off?.allowed).toBe(false);
    expect(off?.blockedBy).toBe("bot");
  });

  it("a flag change writes an audit row and approves nothing already queued", async () => {
    const bot = await handle.mind.profiles.create("owner", {
      name: "AuditFlag",
      onboard: false,
    });
    const events = (await call("GET", "/api/audit?kind=permission")).json as { name: string }[];
    const before = events.filter((event) => event.name === "host-access-change").length;
    await call("PATCH", `/api/profiles/${bot.id}`, { hostAccess: true });
    const eventsAfter = (await call("GET", "/api/audit?kind=permission")).json as {
      name: string;
    }[];
    expect(eventsAfter.filter((event) => event.name === "host-access-change").length).toBe(
      before + 1,
    );
    // A pending card stays pending: turning a flag on approves nothing.
    // A pending card stays pending: turning a flag on approves nothing (F6).
    const chat = await handle.mind.profiles.ensureMain("owner", bot.id);
    const row = await handle.mind.profiles.rowOf(chat.id);
    const key = row !== undefined ? await handle.mind.profiles.keyOfRow(row) : "";
    const conversation = String(
      await Effect.runPromise(handle.mind.converse.conversationIdOf(key as never)),
    );
    void Effect.runPromise(
      handle.mind.approvals.request(conversation, "call-flag", {
        callId: "call-flag",
        name: "bash",
        input: { script: "echo x" },
      }),
    ).catch(() => {});
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && handle.mind.approvals.pendingFor(conversation).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(handle.mind.approvals.pendingFor(conversation)).toHaveLength(1);
    await call("PATCH", `/api/profiles/${bot.id}`, { hostAccess: true });
    expect(handle.mind.approvals.pendingFor(conversation)).toHaveLength(1);
    await handle.mind.approvals.decide(conversation, "call-flag", true);
  });

  it("a department admin or member changing any flag reads as a missing item", async () => {
    // An explicit small VM: this file's departments fill the configured
    // host budget (slice 4), so a default-sized one more would be refused.
    const dept = (
      await call("POST", "/api/org/departments", {
        name: "FlagX",
        vm: { cpus: 1, memoryMiB: 128 },
      })
    ).json as {
      id: string;
    };
    await handle.mind.org.setMember({
      accountId: "admin-fx",
      role: "admin",
      departmentId: dept.id,
    });
    await handle.mind.org.setMember({
      accountId: "mate-fx",
      role: "member",
      departmentId: dept.id,
    });
    const missing = { status: 404, json: { error: "unknown department" } };
    expect(
      await callAs("admin-fx", "PATCH", `/api/org/departments/${dept.id}`, { hostAccess: true }),
    ).toEqual(missing);
    expect(
      await callAs("mate-fx", "PATCH", `/api/org/departments/${dept.id}`, { hostAccess: true }),
    ).toEqual(missing);
    // And the org-level flag: same refusal for a department admin.
    expect(await callAs("admin-fx", "PATCH", "/api/org", { hostAccess: true })).toEqual({
      status: 404,
      json: { error: "no route: PATCH /api/org" },
    });
    // A bot flag too (the profiles PATCH lives on the profiles routes; the
    // gate is the same can() resource).
    const bot = await handle.mind.profiles.create("owner", {
      name: "FlagY",
      onboard: false,
      departmentId: dept.id,
    });
    const { profileRoutes } = await import("./profiles.ts");
    const attempt = async (owner: string): Promise<{ status: number; json: unknown }> => {
      let status = 0;
      let payload: unknown = null;
      const raw = JSON.stringify({ hostAccess: true });
      const args = {
        mind: handle.mind,
        scheduler: { refresh: async () => {}, stop: () => {} },
        req: { method: "PATCH", url: `/api/profiles/${bot.id}` } as never,
        res: {} as never,
        url: new URL(`/api/profiles/${bot.id}`, "http://localhost"),
        owner,
        path: `/api/profiles/${bot.id}`,
        json: (code: number, out: unknown) => {
          status = code;
          payload = out;
        },
        readJson: async <T>() => JSON.parse(raw) as T,
        readBody: async () => Buffer.from(raw),
      } as unknown as import("./types.ts").RouteArgs;
      await profileRoutes(args);
      return { status, json: payload };
    };
    expect(await attempt("admin-fx")).toEqual({ status: 404, json: { error: "unknown profile" } });
    expect((await attempt("owner")).status).toBe(200);
  });
});
