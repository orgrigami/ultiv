/**
 * The public webhook ingress over the real REST handler: an oversized body
 * gets 413 without the whole upload being read, and callers without the
 * token cannot write unbounded reject records (throwaway stores).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { listRoutineEvents, MAX_WEBHOOK_BODY_BYTES, openMind } from "@spriessen/mind";
import { createRestHandler } from "../rest.ts";
import { AuthStore } from "../auth/store.ts";
import { signInForTest } from "../auth/test-auth.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-hook-ingress-"));
process.env["AUTH_DIR"] = join(scratch, "auth");
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");

let handle: Awaited<ReturnType<typeof openMind>>;
let server: Server;
let port = 0;
let hookId = "";

beforeAll(async () => {
  handle = await openMind({ storage: new MemoryStorage() });
  const bot = await handle.mind.profiles.create("owner", { name: "Hooked" });
  const sessionId = (await handle.mind.profiles.ensureMain("owner", bot.id)).id;
  server = createServer(
    createRestHandler({
      mind: handle.mind,
      scheduler: { refresh: async () => {}, stop: () => {} },
      auth: new AuthStore(),
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  port = typeof address === "object" && address !== null ? address.port : 0;
  const cookie = await signInForTest(`http://127.0.0.1:${port}`);
  const created = await fetch(`http://127.0.0.1:${port}/api/webhooks`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ sessionId }),
  });
  hookId = String(((await created.json()) as { id: string }).id);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** Stream `total` bytes at the ingress; resolve with the status and how much was written. */
const flood = (total: number): Promise<{ status: number; sent: number }> =>
  new Promise((resolve) => {
    let sent = 0;
    let status = 0;
    const req = request(
      { host: "127.0.0.1", port, method: "POST", path: `/hooks/${hookId}?token=wrong` },
      (res) => {
        status = res.statusCode ?? 0;
        res.resume();
        res.on("end", () => resolve({ status, sent }));
      },
    );
    req.on("error", () => resolve({ status, sent }));
    const chunk = Buffer.alloc(64 * 1024, 120);
    const pump = (): void => {
      while (sent < total) {
        sent += chunk.length;
        if (!req.write(chunk)) {
          req.once("drain", pump);
          return;
        }
      }
      req.end();
    };
    pump();
  });

describe("webhook ingress", () => {
  it("answers 413 to an oversized body without reading all of it", async () => {
    const result = await flood(64 * 1024 * 1024);
    expect(result.status).toBe(413);
    expect(result.sent).toBeLessThan(64 * 1024 * 1024);
    expect(MAX_WEBHOOK_BODY_BYTES).toBeLessThan(1024 * 1024);
  });

  it("bounds the reject records a caller without the token can write", async () => {
    const before = (await listRoutineEvents(handle.mind.converse)).length;
    for (let i = 0; i < 40; i += 1) {
      const res = await fetch(`http://127.0.0.1:${port}/hooks/${hookId}?token=wrong`, {
        method: "POST",
        body: "{}",
      });
      expect(res.status).toBe(401);
    }
    const written = (await listRoutineEvents(handle.mind.converse)).length - before;
    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThanOrEqual(10);
  });
});
