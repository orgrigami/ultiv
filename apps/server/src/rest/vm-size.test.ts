/**
 * VM size per home over REST (phase 4 slice 4): the org owner sets the org
 * VM's and a department's stored size; out-of-bounds values are a 400 in
 * the dialog's words; a set whose CONFIGURED memory sums past half the
 * host's RAM is refused (the configured-sum heuristic — never a live
 * measurement); and a change answers with the note that it takes effect at
 * the NEXT VM start.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { totalmem } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "@spriessen/mind";
import { VM_CHANGE_NOTE, VM_MEMORY_MIB_MAX } from "@spriessen/contracts";
import { createRestHandler } from "../rest.ts";
import { AuthStore } from "../auth/store.ts";
import { signInForTest } from "../auth/test-auth.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-vm-size-rest-"));
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
  dept = (await handle.mind.org.createDepartment({ name: "Ops" }, "owner")).id;
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

describe("the org VM's size", () => {
  it("the owner sets it; the row reads it back; the change answers the next-start note", async () => {
    const made = await call("PATCH", "/api/org", { vm: { cpus: 2, memoryMiB: 1024 } });
    expect(made.status).toBe(200);
    expect((made.json as { vm: unknown }).vm).toEqual({ cpus: 2, memoryMiB: 1024 });
    expect((made.json as { vmNote?: string }).vmNote).toBe(VM_CHANGE_NOTE);
    const view = await call("GET", "/api/org");
    expect((view.json as { org: { vm: unknown } }).org.vm).toEqual({ cpus: 2, memoryMiB: 1024 });
  });

  it("an out-of-bounds size is a 400 in the dialog's words", async () => {
    const cpus = await call("PATCH", "/api/org", { vm: { cpus: 64, memoryMiB: 512 } });
    expect(cpus.status).toBe(400);
    expect((cpus.json as { error: string }).error).toMatch(/VM CPUs must be a whole number/);
    const memory = await call("PATCH", "/api/org", { vm: { cpus: 1, memoryMiB: 65_536 } });
    expect(memory.status).toBe(400);
    expect((memory.json as { error: string }).error).toMatch(
      /VM memory \(MiB\) must be a whole number from 128 to 8192/,
    );
  });
});

describe("a department VM's size", () => {
  it("created with a size, then edited; the edit answers the next-start note", async () => {
    const made = await call("POST", "/api/org/departments", {
      name: "Lab",
      vm: { cpus: 1, memoryMiB: 2048 },
    });
    expect(made.status).toBe(200);
    expect((made.json as { vm: unknown }).vm).toEqual({ cpus: 1, memoryMiB: 2048 });
    const patched = await call("PATCH", `/api/org/departments/${dept}`, {
      vm: { cpus: 2, memoryMiB: 1024 },
    });
    expect(patched.status).toBe(200);
    expect((patched.json as { vm: unknown }).vm).toEqual({ cpus: 2, memoryMiB: 1024 });
    expect((patched.json as { vmNote?: string }).vmNote).toBe(VM_CHANGE_NOTE);
  });

  it("an out-of-bounds size is a 400 in the dialog's words", async () => {
    const answer = await call("PATCH", `/api/org/departments/${dept}`, {
      vm: { cpus: 0, memoryMiB: 512 },
    });
    expect(answer.status).toBe(400);
    expect((answer.json as { error: string }).error).toMatch(/VM CPUs must be a whole number/);
  });
});

describe("the host-capacity refusal over REST", () => {
  it("a set of sizes summing past half the host's RAM is a 400", async () => {
    // Grow the org's VM to sit exactly ON the configured budget (the
    // stored departments stay as the tests above left them: 2048 + 1024),
    // so any department's default 512 MiB pushes the sum past it.
    const budgetMiB = Math.floor((totalmem() * 0.5) / (1024 * 1024));
    const target = Math.min(VM_MEMORY_MIB_MAX, budgetMiB) - 3_072;
    const grown = await call("PATCH", "/api/org", { vm: { cpus: 1, memoryMiB: target } });
    expect(grown.status).toBe(200);
    const refused = await call("POST", "/api/org/departments", { name: "Over" });
    expect(refused.status).toBe(400);
    expect((refused.json as { error: string }).error).toMatch(
      new RegExp(`ask for ${target + 3_072 + 512} MiB of memory`),
    );
    // A department edit is refused the same way; the owner shrinks back.
    const deptRefused = await call("PATCH", `/api/org/departments/${dept}`, {
      vm: { cpus: 1, memoryMiB: 4096 },
    });
    expect(deptRefused.status).toBe(400);
    expect((deptRefused.json as { error: string }).error).toMatch(/half its RAM/);
    const shrunk = await call("PATCH", "/api/org", { vm: { cpus: 1, memoryMiB: 512 } });
    expect(shrunk.status).toBe(200);
  });
});
