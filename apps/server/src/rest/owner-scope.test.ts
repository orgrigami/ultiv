/**
 * Owner scoping over the real REST handler and an offline mind: owner-b
 * can't see, change or probe owner-a's routines, bot state, audit or
 * artifacts, and gets the same answer a missing item gets. A caller with no
 * header is "guest" and keeps working on its own data (single-user mode).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createCronJob, createSensor, openMind } from "@spreissen/mind";
import { createRestHandler } from "../rest.ts";

const scratch = mkdtempSync(join(tmpdir(), "spreissen-owner-scope-"));
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");

let handle: Awaited<ReturnType<typeof openMind>>;
let server: Server;
let base = "";
const ids = { a: { bot: "", session: "" }, guest: { bot: "", session: "" } };
const records = { cron: "", sensor: "", webhook: "" };

const call = async (owner: string | null, method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(owner !== null ? { "x-spreissen-user": owner } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: (await response.json()) as any };
};

beforeAll(async () => {
  handle = await openMind({ storage: new MemoryStorage() });
  const { mind } = handle;
  const botA = await mind.profiles.create("owner-a", { name: "Alpha" });
  const sessionA = await mind.profiles.ensureMain("owner-a", botA.id);
  const botG = await mind.profiles.create("guest", { name: "Solo" });
  const sessionG = await mind.profiles.ensureMain("guest", botG.id);
  ids.a = { bot: botA.id, session: sessionA.id };
  ids.guest = { bot: botG.id, session: sessionG.id };
  records.cron = (
    await createCronJob(mind.converse, mind.profiles, {
      sessionId: sessionA.id,
      schedule: "0 9 * * *",
      prompt: "tick",
    })
  ).id;
  records.sensor = (
    await createSensor(mind.converse, mind.profiles, {
      sessionId: sessionA.id,
      kind: "rss",
      url: "https://example.com/feed.xml",
      match: "",
    } as Parameters<typeof createSensor>[2])
  ).id;
  records.webhook = (await mind.webhooks.create({ sessionId: sessionA.id, name: "door" })).id;
  await mind.state.set(botA.id, "seen", "42");
  const audited = {
    ...mind,
    audit: {
      ...mind.audit,
      tail: () => [
        {
          at: 1,
          kind: "tool_call",
          conversationId: "c",
          profile: botA.id,
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
  });
  server = createServer(rest);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("routine registries are owner-scoped", () => {
  it("lists only the caller's own cron jobs, sensors and webhooks", async () => {
    for (const [path, id] of [
      ["/api/cron", records.cron],
      ["/api/sensors", records.sensor],
      ["/api/webhooks", records.webhook],
    ] as const) {
      const mine = await call("owner-a", "GET", path);
      expect(
        mine.json.map((r: { id: string }) => r.id),
        path,
      ).toContain(id);
      const theirs = await call("owner-b", "GET", path);
      expect(theirs.json, path).toEqual([]);
    }
  });

  it("refuses another owner's delete exactly like a missing id", async () => {
    for (const path of [
      `/api/cron/${records.cron}`,
      `/api/sensors/${records.sensor}`,
      `/api/webhooks/${records.webhook}`,
    ]) {
      const foreign = await call("owner-b", "DELETE", path);
      const missing = await call("owner-b", "DELETE", `${path}-nope`);
      expect(foreign, path).toEqual(missing);
      expect(foreign.json, path).toEqual({ ok: false });
    }
    // Still there for its owner.
    expect((await call("owner-a", "GET", "/api/cron")).json).toHaveLength(1);
  });

  it("refuses another owner's webhook test-fire like a missing one", async () => {
    const foreign = await call("owner-b", "POST", `/api/webhooks/${records.webhook}/test`, {});
    const missing = await call("owner-b", "POST", "/api/webhooks/nope/test", {});
    expect(foreign).toEqual(missing);
    expect(foreign.status).toBe(404);
    expect(
      (await call("owner-a", "POST", `/api/webhooks/${records.webhook}/test`, {})).status,
    ).toBe(200);
  });

  it("won't attach a routine to another owner's session", async () => {
    const cron = await call("owner-b", "POST", "/api/cron", {
      sessionId: ids.a.session,
      schedule: "0 9 * * *",
      prompt: "x",
    });
    const cronMissing = await call("owner-b", "POST", "/api/cron", {
      sessionId: "no-such-session",
      schedule: "0 9 * * *",
      prompt: "x",
    });
    expect(cron).toEqual(cronMissing);
    expect(cron.status).toBe(404);
    const hook = await call("owner-b", "POST", "/api/webhooks", { sessionId: ids.a.session });
    expect(hook.status).toBe(404);
    expect(hook.json).toEqual({ error: "unknown session" });
  });

  it("hides another owner's fire receipts", async () => {
    const mine = await call("owner-a", "GET", `/api/routines/events?routine=${records.webhook}`);
    expect(mine.json.length).toBeGreaterThan(0);
    expect(
      (await call("owner-b", "GET", `/api/routines/events?routine=${records.webhook}`)).json,
    ).toEqual([]);
    expect((await call("owner-b", "GET", "/api/routines/events")).json).toEqual([]);
  });
});

describe("bot state, audit and artifacts are owner-scoped", () => {
  it("reads and deletes bot state only for the owner", async () => {
    const theirs = await call("owner-b", "GET", `/api/state?profile=${ids.a.bot}`);
    expect(theirs.json).toEqual((await call("owner-b", "GET", "/api/state?profile=nope")).json);
    expect((await call("owner-b", "DELETE", `/api/state/${ids.a.bot}/seen`)).json).toEqual({
      ok: false,
    });
    expect(
      JSON.stringify((await call("owner-a", "GET", `/api/state?profile=${ids.a.bot}`)).json),
    ).toContain("42");
  });

  it("tails audit events of the caller's own bots only", async () => {
    const mine = await call("owner-a", "GET", "/api/audit");
    expect(mine.json.map((e: { name: string }) => e.name)).toEqual(["a"]);
    expect((await call("owner-b", "GET", "/api/audit")).json).toEqual([]);
  });

  it("keeps another owner's artifacts at 404 and their bot's list empty", async () => {
    const upload = await fetch(`${base}/api/artifacts?name=a.md&sessionId=${ids.a.session}`, {
      method: "POST",
      body: "# a",
      headers: { "x-spreissen-user": "owner-a" },
    });
    const art = (await upload.json()) as { id: string };
    expect(upload.status).toBe(200);
    const foreign = await call("owner-b", "GET", `/api/artifacts/${art.id}/meta`);
    expect(foreign).toEqual(await call("owner-b", "GET", "/api/artifacts/nope/meta"));
    expect(foreign.status).toBe(404);
    expect((await call("owner-b", "DELETE", `/api/artifacts/${art.id}`)).status).toBe(404);
    expect((await call("owner-b", "GET", `/api/artifacts?profile=${ids.a.bot}`)).json).toEqual([]);
    const intoForeign = await fetch(`${base}/api/artifacts?name=b.md&sessionId=${ids.a.session}`, {
      method: "POST",
      body: "# b",
      headers: { "x-spreissen-user": "owner-b" },
    });
    expect(intoForeign.status).toBe(404);
    expect((await call("owner-a", "GET", `/api/artifacts/${art.id}/meta`)).status).toBe(200);
  });
});

describe("single-user mode (no header) still works", () => {
  it("guest creates, lists and removes its own routines", async () => {
    const made = await call(null, "POST", "/api/cron", {
      sessionId: ids.guest.session,
      schedule: "0 9 * * *",
      prompt: "solo",
    });
    expect(made.status).toBe(200);
    expect((await call(null, "GET", "/api/cron")).json.map((j: { id: string }) => j.id)).toEqual([
      made.json.id,
    ]);
    const hook = await call(null, "POST", "/api/webhooks", { sessionId: ids.guest.session });
    expect(hook.status).toBe(200);
    expect((await call(null, "DELETE", `/api/cron/${made.json.id}`)).json).toEqual({ ok: true });
    expect((await call(null, "DELETE", `/api/webhooks/${hook.json.id}`)).json).toEqual({
      ok: true,
    });
  });
});
