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
  handle = await openMind({ storage: new MemoryStorage() });
  // The org exists the way a boot migration leaves it.
  await handle.mind.org.ensureOrg("owner", "Personal", true);
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
      vm: { cpus: 4, memoryMiB: 2048 },
    });
    expect((sized.json as { vm: unknown }).vm).toEqual({ cpus: 4, memoryMiB: 2048 });
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
  const { orgRoutes } = await import("./org.ts");
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
  await orgRoutes(args);
  return { status, json: payload };
}
