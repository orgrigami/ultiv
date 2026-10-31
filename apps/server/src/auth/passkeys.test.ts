/**
 * Passkey route wiring without a real authenticator: registration options
 * need a session, authentication options 404 while none is registered, and
 * a garbage assertion is refused (never a session). The browser round-trip
 * with a virtual authenticator is verified separately, in the browser.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "@spriessen/mind";
import { createRestHandler } from "../rest.ts";
import { AuthStore } from "./store.ts";
import { signInForTest } from "./test-auth.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-passkeys-"));
process.env["AUTH_DIR"] = join(scratch, "auth");
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");

let server: Server;
let base = "";
let cookie = "";

const call = async (method: string, path: string, body?: unknown, withCookie?: string) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(withCookie !== undefined ? { cookie: withCookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: (await response.json()) as any };
};

beforeAll(async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
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
  await new Promise<void>((resolve) =>
    fetch(`${base}/api/auth/sign-out`, { method: "POST", headers: { cookie } }).then(() =>
      resolve(),
    ),
  );
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(scratch, { recursive: true, force: true });
});

describe("passkey wiring", () => {
  it("registration options need a session", async () => {
    expect((await call("POST", "/api/auth/passkey/register-options")).status).toBe(401);
    const reply = await call("POST", "/api/auth/passkey/register-options", undefined, cookie);
    expect(reply.status).toBe(200);
    expect(reply.json.options).toMatchObject({
      rp: { name: "Spriessen" },
      user: { name: "owner" },
    });
    expect(typeof reply.json.token).toBe("string");
  });

  it("authentication options 404 while no passkey is registered", async () => {
    expect((await call("POST", "/api/auth/passkey/auth-options")).status).toBe(404);
  });

  it("a garbage assertion is refused and never yields a session", async () => {
    const optionsReply = await call("POST", "/api/auth/passkey/auth-options", undefined, cookie);
    // Still 404: nothing registered. Force the issue with a fake token.
    const forged = await call("POST", "/api/auth/passkey/auth", {
      token: "not-a-real-token",
      response: { id: "nope", rawId: "nope", type: "public-key" },
    });
    expect(forged.status).toBe(401);
    expect(forged.json.error).toContain("could not be verified");
    expect(optionsReply.status).toBe(404);
  });

  it("lists and removes via the session", async () => {
    expect((await call("GET", "/api/auth/passkeys")).status).toBe(401);
    const list = await call("GET", "/api/auth/passkeys", undefined, cookie);
    expect(list.status).toBe(200);
    expect(list.json).toEqual([]);
    expect((await call("DELETE", "/api/auth/passkeys/nope", undefined, cookie)).json).toEqual({
      ok: false,
    });
  });
});
