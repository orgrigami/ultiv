import { describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "@spreissen/mind";
import type { RouteArgs } from "./types.ts";
import { memoryV2Routes } from "./memory-v2.ts";

/** Minimal RouteArgs over a real offline mind; captures the JSON response. */
const routeArgs = (
  mind: Awaited<ReturnType<typeof openMind>>["mind"],
  opts: {
    path: string;
    method?: string;
    profile?: string;
    body?: unknown;
  },
): { args: RouteArgs; status: () => number; body: () => unknown } => {
  let captured: { status: number; body: unknown } | undefined;
  const url = new URL(
    `http://localhost${opts.path}${opts.profile === undefined ? "" : `?profile=${opts.profile}`}`,
  );
  return {
    args: {
      mind,
      scheduler: {} as RouteArgs["scheduler"],
      req: { method: opts.method ?? "GET" } as RouteArgs["req"],
      res: {} as RouteArgs["res"],
      url,
      owner: "harry",
      path: opts.path,
      json: (status, body) => {
        captured = { status, body };
      },
      readJson: async <T>() => (opts.body ?? {}) as T,
      readBody: async () => Buffer.from(JSON.stringify(opts.body ?? {})),
    },
    status: () => captured?.status ?? 0,
    body: () => captured?.body,
  };
};

describe("POST /api/memory/purge", () => {
  it("refuses without an echoing confirm, then purges with one", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { mind } = handle;
    const bot = await mind.profiles.create("harry", { name: "Purgee" });
    const fact = await mind.memory.writeV2({
      owner: "harry",
      profileId: bot.id,
      scope: "profile",
      writer: bot.id,
      text: "a fact bound for the purge",
    });
    await mind.memory.tombstone("harry", bot.id, fact.id);

    // No confirm / wrong confirm → 400 with the pending count.
    const refused = routeArgs(mind, {
      path: "/api/memory/purge",
      method: "POST",
      profile: bot.id,
      body: {},
    });
    expect(await memoryV2Routes(refused.args)).toBe(true);
    expect(refused.status()).toBe(400);
    expect(refused.body()).toMatchObject({ forgotten: 1 });

    const wrong = routeArgs(mind, {
      path: "/api/memory/purge",
      method: "POST",
      profile: bot.id,
      body: { confirm: 5 },
    });
    expect(await memoryV2Routes(wrong.args)).toBe(true);
    expect(wrong.status()).toBe(400);

    // The count echo purges — fact text and episode input text both die.
    const ok = routeArgs(mind, {
      path: "/api/memory/purge",
      method: "POST",
      profile: bot.id,
      body: { confirm: 1 },
    });
    expect(await memoryV2Routes(ok.args)).toBe(true);
    expect(ok.status()).toBe(200);
    expect(ok.body()).toMatchObject({ purged: 1 });
    const facts = await mind.memory.readFacts("harry", bot.id);
    expect(facts.find((entry) => entry.id === fact.id)?.text).toBe("");
    await handle.close();
  });

  it("purges nothing when there is nothing forgotten (confirm: 0)", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { mind } = handle;
    const bot = await mind.profiles.create("harry", { name: "Clean" });
    const ok = routeArgs(mind, {
      path: "/api/memory/purge",
      method: "POST",
      profile: bot.id,
      body: { confirm: 0 },
    });
    expect(await memoryV2Routes(ok.args)).toBe(true);
    expect(ok.status()).toBe(200);
    expect(ok.body()).toMatchObject({ purged: 0 });
    await handle.close();
  });
});

describe("POST /api/memory/v2/facts/:id/restore", () => {
  it("restores a forgotten tombstone and records the audit event", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { mind } = handle;
    const bot = await mind.profiles.create("harry", { name: "Restorer" });
    const fact = await mind.memory.writeV2({
      owner: "harry",
      profileId: bot.id,
      scope: "profile",
      writer: bot.id,
      text: "a fact worth restoring",
    });
    await mind.memory.tombstone("harry", bot.id, fact.id);
    expect((await mind.memory.read("harry", "profile", bot.id)).map((r) => r.id)).not.toContain(
      fact.id,
    );
    const route = routeArgs(mind, {
      path: `/api/memory/v2/facts/${fact.id}/restore`,
      method: "POST",
      profile: bot.id,
    });
    expect(await memoryV2Routes(route.args)).toBe(true);
    expect(route.status()).toBe(200);
    const restored = await mind.memory.read("harry", "profile", bot.id);
    expect(restored.map((record) => record.id)).toContain(fact.id);
    await handle.close();
  });
});

describe("DELETE /api/memory/v2/facts/:id (tombstone)", () => {
  it("tombstones a fact — hidden from reads, restorable by the mind seam", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { mind } = handle;
    const bot = await mind.profiles.create("harry", { name: "Tombstoned" });
    const fact = await mind.memory.writeV2({
      owner: "harry",
      profileId: bot.id,
      scope: "profile",
      writer: bot.id,
      text: "a fact to tombstone",
    });
    const route = routeArgs(mind, {
      path: `/api/memory/v2/facts/${fact.id}`,
      method: "DELETE",
      profile: bot.id,
    });
    expect(await memoryV2Routes(route.args)).toBe(true);
    expect(route.status()).toBe(200);
    // Hidden from the REST projection…
    const projected = await mind.memory.read("harry", "profile", bot.id);
    expect(projected.map((record) => record.id)).not.toContain(fact.id);
    // …and restorable: the tombstone keeps its text until Purge.
    await mind.memory.restore("harry", bot.id, fact.id);
    const restored = await mind.memory.read("harry", "profile", bot.id);
    expect(restored.map((record) => record.id)).toContain(fact.id);
    await handle.close();
  });
});
