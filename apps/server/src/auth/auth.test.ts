/**
 * Sign-in over the real REST handler: the loopback bootstrap (no passcode
 * yet), the refusal for proxied (LAN/tailnet-shaped) requests, cookie flags,
 * the sign-in throttle, sign-out and the passcode change. A request is made
 * "non-loopback" the way a proxy makes it: with x-forwarded-for set.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "@spriessen/mind";
import { createRestHandler } from "../rest.ts";
import { AuthStore } from "./store.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-auth-test-"));
process.env["AUTH_DIR"] = join(scratch, "auth");
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");

let server: Server;
let store: AuthStore;
let base = "";
const PASSCODE = "correct horse battery";

interface Reply {
  status: number;
  setCookie: string | null;
  json: any;
}

const call = async (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      // State changes always name JSON (the cross-site fence refuses typeless posts).
      ...(body !== undefined || method !== "GET" ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await response.text();
  return {
    status: response.status,
    setCookie: response.headers.get("set-cookie"),
    json: (() => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })(),
  };
};

/** Lift the throttle the way the recovery command would: on disk. */
const unlock = (): void => {
  const file = join(scratch, "auth", "auth.json");
  const shape = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...shape, failCount: 0, lockedUntil: 0 }));
};

const cookieHeader = (reply: Reply): Record<string, string> =>
  reply.setCookie !== null ? { cookie: reply.setCookie.split(";")[0] ?? "" } : {};

beforeAll(async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  store = new AuthStore();
  const rest = createRestHandler({
    mind: handle.mind,
    scheduler: { refresh: async () => {}, stop: () => {} },
    auth: store,
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

describe("passcode sign-in", () => {
  it("answers status publicly and refuses a proxied (non-loopback) request", async () => {
    const status = await call("GET", "/api/auth/status");
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({ passcodeSet: false, bootstrap: true, session: false });
    const proxied = await call("GET", "/api/sessions", undefined, {
      "x-forwarded-for": "10.20.30.40",
    });
    expect(proxied.status).toBe(401);
    expect(proxied.json).toEqual({ error: "sign in required" });
    const health = await call("GET", "/api/health");
    expect(health.status).toBe(200);
  });

  it("before a passcode exists, loopback reaches only the set-passcode step", async () => {
    // Bootstrap is one step, not a free pass: reads and writes stay closed.
    for (const [method, path, body] of [
      ["GET", "/api/sessions", undefined],
      ["GET", "/api/profiles", undefined],
      ["POST", "/api/profiles", { name: "owner-a bot" }],
      ["GET", "/api/vault", undefined],
    ] as const) {
      const reply = await call(method, path, body);
      expect(reply.status, `${method} ${path}`).toBe(401);
      expect(reply.json).toEqual({ error: "sign in required" });
    }
  });

  it("refuses passcode setup from a proxied request, allows it from loopback", async () => {
    const remote = await call(
      "POST",
      "/api/auth/passcode",
      { passcode: "remote attempt 1" },
      {
        "x-forwarded-for": "10.20.30.40",
      },
    );
    expect(remote.status).toBe(403);
    const short = await call("POST", "/api/auth/passcode", { passcode: "short" });
    expect(short.status).toBe(400);
    const set = await call("POST", "/api/auth/passcode", { passcode: PASSCODE });
    expect(set.status).toBe(200);
    // HttpOnly and SameSite=Strict always; Secure only over HTTPS.
    expect(set.setCookie).toContain("HttpOnly");
    expect(set.setCookie).toContain("SameSite=Strict");
    expect(set.setCookie).not.toContain("Secure");
    const again = await call("POST", "/api/auth/passcode", { passcode: "another pass 1" });
    expect(again.status).toBe(409);
  });

  it("adds Secure to the cookie when the request came over HTTPS", async () => {
    const reply = await call(
      "POST",
      "/api/auth/sign-in",
      { passcode: PASSCODE },
      { "x-forwarded-proto": "https" },
    );
    expect(reply.status).toBe(200);
    expect(reply.setCookie).toContain("Secure");
  });

  it("needs a session after the passcode exists, loopback included", async () => {
    const anonymous = await call("GET", "/api/sessions");
    expect(anonymous.status).toBe(401);
    const bootstrap = await call("GET", "/api/auth/status");
    expect(bootstrap.json).toMatchObject({ passcodeSet: true, bootstrap: false });
    const signedIn = await call("POST", "/api/auth/sign-in", { passcode: PASSCODE });
    expect(signedIn.status).toBe(200);
    const list = await call("GET", "/api/sessions", undefined, cookieHeader(signedIn));
    expect(list.status).toBe(200);
    expect(Array.isArray(list.json)).toBe(true);
  });

  it("refuses form-style and typeless bodies on state-changing routes", async () => {
    const signedIn = await call("POST", "/api/auth/sign-in", { passcode: PASSCODE });
    const plain = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "text/plain", ...cookieHeader(signedIn) },
      body: "x",
    });
    expect(plain.status).toBe(415);
    const form = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...cookieHeader(signedIn),
      },
      body: "a=1",
    });
    expect(form.status).toBe(415);
    // A typeless post (no body, or an untyped Blob) needs no preflight
    // either, so it is refused too; the same post naming JSON passes.
    const typeless = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: cookieHeader(signedIn),
    });
    expect(typeless.status).toBe(415);
    const signOut = await fetch(`${base}/api/auth/sign-out`, {
      method: "POST",
      headers: cookieHeader(signedIn),
    });
    expect(signOut.status).toBe(415);
    const named = await call("POST", "/api/sessions", undefined, cookieHeader(signedIn));
    expect(named.status).not.toBe(415);
  });

  it("ends the session on sign-out", async () => {
    const signedIn = await call("POST", "/api/auth/sign-in", { passcode: PASSCODE });
    const out = await call("POST", "/api/auth/sign-out", undefined, cookieHeader(signedIn));
    expect(out.status).toBe(200);
    expect(out.setCookie).toContain("Max-Age=0");
    const after = await call("GET", "/api/sessions", undefined, cookieHeader(signedIn));
    expect(after.status).toBe(401);
  });

  it("changes the passcode only from a session, under the throttle", async () => {
    // No session: the public prefix must not make this an anonymous oracle.
    const anonymous = await call("POST", "/api/auth/passcode/change", {
      current: PASSCODE,
      next: "anonymous new pass",
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.json).toEqual({ error: "sign in required" });
    const signedIn = await call("POST", "/api/auth/sign-in", { passcode: PASSCODE });
    const jar = cookieHeader(signedIn);
    // Wrong guesses through the change form count toward the same lock.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await call(
        "POST",
        "/api/auth/passcode/change",
        { current: `guess ${attempt}`, next: "another good pass" },
        jar,
      );
      expect(wrong.status).toBe(401);
    }
    const locked = await call(
      "POST",
      "/api/auth/passcode/change",
      { current: PASSCODE, next: "another good pass" },
      jar,
    );
    expect(locked.status).toBe(429);
    expect((await call("POST", "/api/auth/sign-in", { passcode: PASSCODE })).status).toBe(429);
  });

  it("changes the passcode with the current one, and signs out the other sessions", async () => {
    unlock();
    const signedIn = await call("POST", "/api/auth/sign-in", { passcode: PASSCODE });
    const other = await call("POST", "/api/auth/sign-in", { passcode: PASSCODE });
    const jar = cookieHeader(signedIn);
    const wrong = await call(
      "POST",
      "/api/auth/passcode/change",
      { current: "not it", next: "another good pass" },
      jar,
    );
    expect(wrong.status).toBe(401);
    const ok = await call(
      "POST",
      "/api/auth/passcode/change",
      { current: PASSCODE, next: "another good pass" },
      jar,
    );
    expect(ok.status).toBe(200);
    // The changing session stays; the other one is gone.
    expect((await call("GET", "/api/sessions", undefined, jar)).status).toBe(200);
    expect((await call("GET", "/api/sessions", undefined, cookieHeader(other))).status).toBe(401);
    const old = await call("POST", "/api/auth/sign-in", { passcode: PASSCODE });
    expect(old.status).toBe(401);
    const fresh = await call("POST", "/api/auth/sign-in", { passcode: "another good pass" });
    expect(fresh.status).toBe(200);
  });

  it("rate-limits wrong passcodes", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await call("POST", "/api/auth/sign-in", { passcode: `wrong ${attempt}` });
      expect(wrong.status).toBe(401);
    }
    const locked = await call("POST", "/api/auth/sign-in", { passcode: "another good pass" });
    expect(locked.status).toBe(429);
    expect(locked.json.error).toContain("too many attempts");
  });
});

describe("a body the auth routes cannot use", () => {
  const raw = (body: string) =>
    fetch(`${base}/api/auth/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

  it("is the caller's mistake (4xx), never a server error", async () => {
    expect((await raw("{not json")).status).toBe(400);
    expect((await raw("[]")).status).toBe(400);
    expect((await raw("null")).status).toBe(400);
    expect((await raw(JSON.stringify({ passcode: "x".repeat(70_000) }))).status).toBe(413);
  });
});
