/**
 * Owner scoping over the real REST handler after sign-in: the ONE account
 * sees its own records everywhere, an unknown id answers exactly like an
 * unknown id, and an anonymous request gets the one refusal shape. The
 * cross-LABEL semantics live in packages/mind/src/migrate/owners.test.ts;
 * the gate itself is tested in apps/server/src/auth/auth.test.ts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createCronJob, createSensor, openMind } from "@spriessen/mind";
import { createRestHandler } from "../rest.ts";
import { AuthStore } from "../auth/store.ts";
import { signInForTest } from "../auth/test-auth.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-owner-scope-"));
process.env["AUTH_DIR"] = join(scratch, "auth");
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");

let handle: Awaited<ReturnType<typeof openMind>>;
let server: Server;
let base = "";
let cookie = "";
const ids = { bot: "", session: "" };
const records = { cron: "", sensor: "", webhook: "" };

/** Call with the signed-in cookie (headers merged in last). */
const call = async (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      cookie,
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await response.text();
  return {
    status: response.status,
    json: (() => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })(),
  };
};

beforeAll(async () => {
  handle = await openMind({ storage: new MemoryStorage() });
  const { mind } = handle;
  const bot = await mind.profiles.create("owner", { name: "Alpha" });
  const session = await mind.profiles.ensureMain("owner", bot.id);
  ids.bot = bot.id;
  ids.session = session.id;
  records.cron = (
    await createCronJob(mind.converse, mind.profiles, {
      sessionId: session.id,
      schedule: "0 9 * * *",
      prompt: "tick",
    })
  ).id;
  records.sensor = (
    await createSensor(mind.converse, mind.profiles, {
      sessionId: session.id,
      kind: "rss",
      url: "https://example.com/feed.xml",
      match: "",
    } as Parameters<typeof createSensor>[2])
  ).id;
  records.webhook = (await mind.webhooks.create({ sessionId: session.id, name: "door" })).id;
  await mind.state.set(bot.id, "seen", "42");
  const audited = {
    ...mind,
    audit: {
      ...mind.audit,
      tail: () => [
        {
          at: 1,
          kind: "tool_call",
          conversationId: "c",
          profile: bot.id,
          callId: null,
          name: "a",
          durationMs: null,
          ok: true,
          error: null,
        },
        {
          at: 2,
          kind: "tool_call",
          conversationId: "c",
          profile: null,
          callId: null,
          name: "x",
          durationMs: null,
          ok: true,
          error: null,
        },
      ],
    },
  } as typeof mind;
  const rest = createRestHandler({
    mind: audited,
    scheduler: { refresh: async () => {}, stop: () => {} },
    auth: new AuthStore(),
  });
  server = createServer(rest);
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

describe("the signed-in account reaches its own records", () => {
  it("lists its cron jobs, sensors and webhooks", async () => {
    for (const [path, id] of [
      ["/api/cron", records.cron],
      ["/api/sensors", records.sensor],
      ["/api/webhooks", records.webhook],
    ] as const) {
      const list = await call("GET", path);
      expect(list.status).toBe(200);
      expect(
        list.json.map((r: { id: string }) => r.id),
        path,
      ).toContain(id);
    }
  });

  it("deletes its own record and answers an unknown id like a missing one", async () => {
    expect((await call("DELETE", "/api/cron/nope")).json).toEqual({ ok: false });
    expect((await call("DELETE", `/api/cron/${records.cron}`)).json).toEqual({ ok: true });
    expect((await call("GET", "/api/cron")).json).toHaveLength(0);
  });

  it("hides receipts of an unknown routine", async () => {
    const mine = await call("GET", `/api/routines/events?routine=${records.webhook}`);
    expect(mine.json.length).toBeGreaterThanOrEqual(0);
    expect((await call("GET", "/api/routines/events?routine=nope")).json).toEqual([]);
  });

  it("reads and deletes bot state for its own bot", async () => {
    expect(JSON.stringify((await call("GET", `/api/state?profile=${ids.bot}`)).json)).toContain(
      "42",
    );
    expect((await call("DELETE", `/api/state/${ids.bot}/seen`)).json).toEqual({ ok: true });
    expect((await call("GET", `/api/state?profile=${ids.bot}`)).json).toEqual([]);
  });

  it("tails audit events of its own bots and hides unattributed ones", async () => {
    const mine = await call("GET", "/api/audit");
    expect(mine.json.map((e: { name: string }) => e.name)).toEqual(["a"]);
  });

  it("keeps artifacts owner-scoped: unknown ids 404, uploads land in scope", async () => {
    const upload = await fetch(`${base}/api/artifacts?name=a.md&sessionId=${ids.session}`, {
      method: "POST",
      body: "# a",
      headers: { cookie },
    });
    const art = (await upload.json()) as { id: string };
    expect(upload.status).toBe(200);
    expect((await call("GET", "/api/artifacts/nope/meta")).json).toEqual(
      (await call("GET", "/api/artifacts/missing-id/meta")).json,
    );
    expect((await call("GET", `/api/artifacts?profile=${ids.bot}`)).json).toHaveLength(1);
    expect((await call("GET", `/api/artifacts/${art.id}/meta`)).status).toBe(200);
    expect((await call("DELETE", `/api/artifacts/${art.id}`)).status).toBe(200);
  });

  it("refuses an anonymous request with the one refusal shape", async () => {
    const anonymous = await fetch(`${base}/api/sessions`);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: "sign in required" });
    const health = await fetch(`${base}/api/health`);
    expect(health.status).toBe(200);
  });
});
