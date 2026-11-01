/**
 * The per-VM network allowlist over REST (phase 4 slice 3): the org owner
 * or an org admin edits the org VM's list; a department admin edits only
 * their own department VM's; a member and a foreign department's admin read
 * as missing items; a malformed entry is a 400; every change writes a
 * `permission` audit row.
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

const scratch = mkdtempSync(join(tmpdir(), "spriessen-net-allowlist-rest-"));
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
  handle = await openMind({ storage: new MemoryStorage(), destroyHomeVm: async () => {} });
  await handle.mind.org.ensureOrg("owner", "Personal", true);
  await handle.mind.profiles.create("owner", { name: "Keeper", onboard: false });
  dept = (await handle.mind.org.createDepartment({ name: "Ops" }, "owner")).id;
  await handle.mind.org.setMember({ accountId: "admin-ops", role: "admin", departmentId: dept });
  await handle.mind.org.setMember({ accountId: "mate-ops", role: "member", departmentId: dept });
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

describe("the org VM's allowlist (org owner or org admin)", () => {
  it("the owner sets it and reads it back from the org view", async () => {
    const made = await call("PATCH", "/api/org", {
      netAllowlist: ["api.example.com", "*.pypi.org"],
    });
    expect(made.status).toBe(200);
    expect((made.json as { netAllowlist: string[] }).netAllowlist).toEqual([
      "api.example.com",
      "*.pypi.org",
    ]);
    const view = await call("GET", "/api/org");
    expect((view.json as { org: { netAllowlist: string[] } }).org.netAllowlist).toEqual([
      "api.example.com",
      "*.pypi.org",
    ]);
  });

  it("a malformed entry is a 400 in owner words", async () => {
    const answer = await call("PATCH", "/api/org", { netAllowlist: ["https://x.example.com"] });
    expect(answer.status).toBe(400);
    expect(answer.json as { error: string }).toMatchObject({ error: expect.any(String) });
  });

  it("the change is audited", async () => {
    const events = await call("GET", "/api/audit?kind=permission");
    expect((events.json as { name: string }[]).map((event) => event.name)).toContain(
      "org-net-allowlist",
    );
  });
});

describe("a department VM's allowlist (that department's admin)", () => {
  it("the org owner sets it; the department's admin edits their own", async () => {
    const ownerSet = await call("PATCH", `/api/org/departments/${dept}`, {
      netAllowlist: ["files.pythonhosted.org"],
    });
    expect(ownerSet.status).toBe(200);
    const adminSet = await callAs("admin-ops", "PATCH", `/api/org/departments/${dept}`, {
      netAllowlist: ["pypi.org"],
    });
    expect(adminSet.status).toBe(200);
    expect((adminSet.json as { netAllowlist: string[] }).netAllowlist).toEqual(["pypi.org"]);
  });

  it("another department's admin and a member read as missing items", async () => {
    const other = (await call("POST", "/api/org/departments", { name: "East" })).json as {
      id: string;
    };
    await handle.mind.org.setMember({
      accountId: "admin-east",
      role: "admin",
      departmentId: other.id,
    });
    const refusal = { status: 404, json: { error: "unknown department" } };
    expect(
      await callAs("admin-east", "PATCH", `/api/org/departments/${dept}`, { netAllowlist: [] }),
    ).toEqual(refusal);
    expect(
      await callAs("mate-ops", "PATCH", `/api/org/departments/${dept}`, { netAllowlist: [] }),
    ).toEqual(refusal);
  });

  it("the change is audited", async () => {
    const events = await call("GET", "/api/audit?kind=permission");
    expect((events.json as { name: string }[]).map((event) => event.name)).toContain(
      "department-net-allowlist",
    );
  });

  it("a department can be created with its allowlist", async () => {
    const made = await call("POST", "/api/org/departments", {
      name: "West",
      netAllowlist: ["registry.npmjs.org"],
    });
    expect((made.json as { netAllowlist: string[] }).netAllowlist).toEqual(["registry.npmjs.org"]);
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
  const { orgRoutes } = await import("./org.ts");
  await orgRoutes(args);
  return { status, json: payload };
}
