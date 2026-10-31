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
import { openMind } from "@spreissen/mind";
import { createRestHandler } from "../rest.ts";

const scratch = mkdtempSync(join(tmpdir(), "spreissen-hook-tokens-"));
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");

let handle: Awaited<ReturnType<typeof openMind>>;
let server: Server;
let base = "";
let sessionId = "";

const call = async (owner: string | null, method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(owner !== null ? { "x-spreissen-user": owner } : {}),
    },
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
  const bot = await handle.mind.profiles.create("owner-a", { name: "Hooked" });
  sessionId = (await handle.mind.profiles.ensureMain("owner-a", bot.id)).id;
  server = createServer(
    createRestHandler({
      mind: handle.mind,
      scheduler: { refresh: async () => {}, stop: () => {} },
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("webhook tokens over REST", () => {
  it("shows the token once, then only accepts the current one", async () => {
    const created = await call("owner-a", "POST", "/api/webhooks", { sessionId });
    expect(created.status).toBe(200);
    const token = String(created.json["token"]);
    expect(token).toMatch(/^[0-9a-f-]{36}$/);

    const listed = await call("owner-a", "GET", "/api/webhooks");
    expect(JSON.stringify(listed.json)).not.toContain(token);
    expect(JSON.stringify(listed.json)).not.toContain("sha256:");

    const id = String(created.json["id"]);
    expect(await knock(id, token)).toBe(422);
    expect(await knock(id, "nope")).toBe(401);

    const foreign = await call("owner-b", "POST", `/api/webhooks/${id}/token`);
    expect(foreign).toEqual(await call("owner-b", "POST", "/api/webhooks/nope/token"));
    expect(foreign.status).toBe(404);

    const rotated = await call("owner-a", "POST", `/api/webhooks/${id}/token`);
    expect(rotated.status).toBe(200);
    const fresh = String(rotated.json["token"]);
    expect(fresh).not.toBe(token);
    expect(await knock(id, token)).toBe(401);
    expect(await knock(id, fresh)).toBe(422);
  });
});
