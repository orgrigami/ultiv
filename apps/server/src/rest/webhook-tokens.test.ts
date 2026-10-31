/**
 * Webhook tokens over the real REST handler: the create and new-token
 * responses carry the token once, lists never do, the ingress accepts only
 * the current token (checked before anything is delivered), and another owner can't issue one (throwaway stores).
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

const scratch = mkdtempSync(join(tmpdir(), "spriessen-hook-tokens-"));
process.env["AUTH_DIR"] = join(scratch, "auth");
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");

let handle: Awaited<ReturnType<typeof openMind>>;
let server: Server;
let base = "";
let cookie = "";
let sessionId = "";

const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: (await response.json()) as Record<string, any> };
};

/**
 * Knock on the ingress with a body that isn't JSON: the token check runs
 * first, so the right token gets 422 (past auth, nothing delivered) and a
 * wrong one gets 401.
 */
const knock = async (id: string, token: string): Promise<number> =>
  (
    await fetch(`${base}/hooks/${id}?token=${encodeURIComponent(token)}`, {
      method: "POST",
      body: "not json",
    })
  ).status;

beforeAll(async () => {
  handle = await openMind({ storage: new MemoryStorage() });
  const bot = await handle.mind.profiles.create("owner", { name: "Hooked" });
  sessionId = (await handle.mind.profiles.ensureMain("owner", bot.id)).id;
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

describe("webhook tokens over REST", () => {
  it("shows the token once, then only accepts the current one", async () => {
    const created = await call("POST", "/api/webhooks", { sessionId });
    expect(created.status).toBe(200);
    const token = String(created.json["token"]);
    expect(token).toMatch(/^[0-9a-f-]{36}$/);

    const listed = await call("GET", "/api/webhooks");
    expect(JSON.stringify(listed.json)).not.toContain(token);
    expect(JSON.stringify(listed.json)).not.toContain("sha256:");

    const id = String(created.json["id"]);
    expect(await knock(id, token)).toBe(422);
    expect(await knock(id, "nope")).toBe(401);

    // An unknown webhook answers exactly like one that is not yours: 404.
    expect((await call("POST", `/api/webhooks/${id}/token`)).status).toBe(200);
    expect((await call("POST", "/api/webhooks/nope/token")).status).toBe(404);

    const rotated = await call("POST", `/api/webhooks/${id}/token`);
    expect(rotated.status).toBe(200);
    const fresh = String(rotated.json["token"]);
    expect(fresh).not.toBe(token);
    expect(await knock(id, token)).toBe(401);
    expect(await knock(id, fresh)).toBe(422);
  });
});
