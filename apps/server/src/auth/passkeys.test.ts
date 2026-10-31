/**
 * Passkeys over the real routes: registration options need a session,
 * authentication options 404 while none is registered, a garbage assertion
 * is refused (never a session), and a software authenticator registers,
 * signs in, is refused on a replayed assertion, and is removed (audited).
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
import { softAuthenticator } from "./soft-authenticator.ts";

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
      // State changes always name JSON (the cross-site fence refuses typeless posts).
      ...(body !== undefined || method !== "GET" ? { "content-type": "application/json" } : {}),
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
    fetch(`${base}/api/auth/sign-out`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
    }).then(() =>
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

  it("registers, signs in, refuses a replay, and is removed with an audit row", async () => {
    const host = new URL(base);
    const device = softAuthenticator(host.hostname, base);
    const offer = await call("POST", "/api/auth/passkey/register-options", {}, cookie);
    expect(offer.status).toBe(200);
    const added = await call(
      "POST",
      "/api/auth/passkey/register",
      { token: offer.json.token, response: device.create(offer.json.options) },
      cookie,
    );
    expect(added.json).toEqual({ ok: true });
    const listed = await call("GET", "/api/auth/passkeys", undefined, cookie);
    expect(listed.json.map((row: { id: string }) => row.id)).toEqual([device.id]);

    // Sign in with it: no cookie going in, a session cookie coming out.
    const ask = await call("POST", "/api/auth/passkey/auth-options", {});
    expect(ask.status).toBe(200);
    const assertion = device.get(ask.json.options);
    const signIn = await fetch(`${base}/api/auth/passkey/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: ask.json.token, response: assertion }),
    });
    expect(signIn.status).toBe(200);
    const session = signIn.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect((await call("GET", "/api/sessions", undefined, session)).status).toBe(200);

    // The same assertion again (token used, counter stale) gets nothing.
    const replay = await fetch(`${base}/api/auth/passkey/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: ask.json.token, response: assertion }),
    });
    expect(replay.status).toBe(401);
    expect(replay.headers.get("set-cookie")).toBeNull();

    const removed = await call("DELETE", `/api/auth/passkeys/${device.id}`, undefined, cookie);
    expect(removed.json).toEqual({ ok: true });
    const audit = await call("GET", "/api/audit?kind=auth&limit=200", undefined, cookie);
    const names = (audit.json as { name: string }[]).map((row) => row.name);
    expect(names).toContain("passkey-added");
    expect(names).toContain("passkey-removed");
    expect((await call("POST", "/api/auth/passkey/auth-options", {})).status).toBe(404);
  });
});
