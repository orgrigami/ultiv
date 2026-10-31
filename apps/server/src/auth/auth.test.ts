/**
 * Sign-in over the real REST handler: the loopback bootstrap (no passcode
 * yet), the refusal for proxied (LAN/tailnet-shaped) requests, cookie flags,
 * the sign-in throttle, sign-out and the passcode change. A request is made
 * "non-loopback" the way a proxy makes it: with x-forwarded-for set.
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

const scratch = mkdtempSync(join(tmpdir(), "spriessen-auth-test-"));
process.env["AUTH_DIR"] = join(scratch, "auth");
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");

let server: Server;
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
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
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

const cookieHeader = (reply: Reply): Record<string, string> =>
  reply.setCookie !== null ? { cookie: reply.setCookie.split(";")[0] ?? "" } : {};

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

  it("refuses form-style bodies on state-changing routes, allows bodyless posts", async () => {
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
    // A bodyless post (reset main, set main) passes the fence.
    const bodyless = await call("POST", "/api/sessions", undefined, cookieHeader(signedIn));
    expect(bodyless.status).not.toBe(415);
  });

  it("ends the session on sign-out", async () => {
    const signedIn = await call("POST", "/api/auth/sign-in", { passcode: PASSCODE });
    const out = await call("POST", "/api/auth/sign-out", undefined, cookieHeader(signedIn));
    expect(out.status).toBe(200);
    expect(out.setCookie).toContain("Max-Age=0");
    const after = await call("GET", "/api/sessions", undefined, cookieHeader(signedIn));
    expect(after.status).toBe(401);
  });

  it("changes the passcode with the current one, and not without", async () => {
    const signedIn = await call("POST", "/api/auth/sign-in", { passcode: PASSCODE });
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
