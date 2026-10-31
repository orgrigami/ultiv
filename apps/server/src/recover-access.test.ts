/**
 * The recovery path: run it against a throwaway auth folder, then sign in
 * with the new passcode over the real REST handler. The old passcode stops
 * working and old sessions are gone.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "@spriessen/mind";
import { AuthStore } from "./auth/store.ts";
import { createRestHandler } from "./rest.ts";
import { recoverAccess } from "./recover-access.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-recover-"));
process.env["AUTH_DIR"] = join(scratch, "auth");
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");

let server: Server;
let base = "";

const call = async (method: string, path: string, body?: unknown, cookie?: string) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie !== undefined ? { cookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, setCookie: response.headers.get("set-cookie") };
};

beforeAll(async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const rest = createRestHandler({
    mind: handle.mind,
    scheduler: { refresh: async () => {}, stop: () => {} },
    auth: new AuthStore(),
  });
  server = createServer(rest);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(scratch, { recursive: true, force: true });
});

describe("recover:access", () => {
  it("resets the passcode, clears sessions, and the new passcode signs in", async () => {
    // The state before recovery: an old passcode and a live session.
    const store = new AuthStore();
    store.setPasscode("the lost one");
    const stale = await call("POST", "/api/auth/sign-in", { passcode: "the lost one" });
    expect(stale.status).toBe(200);
    const staleCookie = stale.setCookie?.split(";")[0];

    const passcode = recoverAccess();
    expect(passcode.length).toBeGreaterThanOrEqual(8);
    // The old session no longer opens anything.
    expect((await call("GET", "/api/sessions", undefined, staleCookie)).status).toBe(401);
    // The old passcode is gone.
    expect((await call("POST", "/api/auth/sign-in", { passcode: "the lost one" })).status).toBe(
      401,
    );
    // The recovery passcode signs in.
    const fresh = await call("POST", "/api/auth/sign-in", { passcode });
    expect(fresh.status).toBe(200);
    expect(fresh.setCookie).toContain("HttpOnly");
    expect(
      (await call("GET", "/api/sessions", undefined, fresh.setCookie?.split(";")[0])).status,
    ).toBe(200);
  });

  it("accepts an explicit passcode and is repeatable", async () => {
    const first = recoverAccess({ passcode: "owner picked this" });
    expect(first).toBe("owner picked this");
    const second = recoverAccess({ passcode: "then this one" });
    expect((await call("POST", "/api/auth/sign-in", { passcode: first })).status).toBe(401);
    expect((await call("POST", "/api/auth/sign-in", { passcode: second })).status).toBe(200);
  });
});
