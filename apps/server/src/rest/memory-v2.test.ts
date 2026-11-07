import { describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "@spriessen/mind";
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

  it("refuses a purged tombstone (409) and an unknown fact (404)", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { mind } = handle;
    const bot = await mind.profiles.create("harry", { name: "Purged" });
    const fact = await mind.memory.writeV2({
      owner: "harry",
      profileId: bot.id,
      scope: "profile",
      writer: bot.id,
      text: "a fact purged for good",
    });
    await mind.memory.tombstone("harry", bot.id, fact.id);
    await mind.memory.purge("harry", bot.id);
    const purged = routeArgs(mind, {
      path: `/api/memory/v2/facts/${fact.id}/restore`,
      method: "POST",
      profile: bot.id,
    });
    expect(await memoryV2Routes(purged.args)).toBe(true);
    expect(purged.status()).toBe(409);
    const unknown = routeArgs(mind, {
      path: "/api/memory/v2/facts/nope/restore",
      method: "POST",
      profile: bot.id,
    });
    expect(await memoryV2Routes(unknown.args)).toBe(true);
    expect(unknown.status()).toBe(404);
    const facts = await mind.memory.readFacts("harry", bot.id);
    expect(facts.find((entry) => entry.id === fact.id)).toMatchObject({
      status: "forgotten",
      text: "",
    });
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

describe("accepting a conflict proposal", () => {
  it("keeps the fact the owner chose; the older one retires as changed, never forgotten", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { mind } = handle;
    const bot = await mind.profiles.create("harry", { name: "Keeper", onboard: false });
    const write = (text: string) =>
      mind.memory.writeV2({
        owner: "harry",
        profileId: bot.id,
        scope: "profile",
        writer: bot.id,
        text,
      });
    const older = await write("Harry's gym is Fitness First Kemang");
    const newer = await write("Harry trains at Celebrity Fitness Senayan");
    const { ProposalsDoc, profileKey } = await import("@spriessen/mind");
    const { Effect } = await import("effect");
    await Effect.runPromise(
      mind.converse.docs.commit(async (tx) => {
        const store = await tx.doc(ProposalsDoc, profileKey("harry", bot.id), { proposals: [] });
        store.proposals = [
          {
            id: "p-conflict",
            kind: "conflict",
            at: Date.now(),
            factIds: [older.id, newer.id],
            summary: "These disagree",
            fingerprint: "conflict|x",
            status: "open",
            decidedAt: null,
          },
        ];
      }),
    );
    // Recency never decides: an accept without the owner's choice is refused.
    const unchosen = routeArgs(mind, {
      path: "/api/memory/v2/proposals/p-conflict/accept",
      method: "POST",
      profile: bot.id,
    });
    await memoryV2Routes(unchosen.args);
    expect(unchosen.status()).toBe(400);
    const accept = routeArgs(mind, {
      path: "/api/memory/v2/proposals/p-conflict/accept",
      method: "POST",
      profile: bot.id,
      body: { keep: newer.id },
    });
    await memoryV2Routes(accept.args);
    expect(accept.status()).toBe(200);
    const facts = await mind.memory.readFacts("harry", bot.id);
    const was = facts.find((fact) => fact.id === older.id);
    expect(was?.status).toBe("superseded");
    expect(was?.retired).toBe("changed");
    expect(was?.supersededBy).toBe(newer.id);
    expect(facts.find((fact) => fact.id === newer.id)?.status).toBe("current");
    // A decided proposal is never applied twice.
    const again = routeArgs(mind, {
      path: "/api/memory/v2/proposals/p-conflict/accept",
      method: "POST",
      profile: bot.id,
      body: { keep: newer.id },
    });
    await memoryV2Routes(again.args);
    expect(again.status()).toBe(409);
    await handle.close();
  });
});

describe("POST /api/memory/v2/facts/:id/update", () => {
  it("changes, corrects, ends and confirms a fact as the owner", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { mind } = handle;
    const bot = await mind.profiles.create("harry", { name: "Keeper", onboard: false });
    const write = (text: string, basis?: "inferred") =>
      mind.memory.writeV2({
        owner: "harry",
        profileId: bot.id,
        scope: "profile",
        writer: bot.id,
        text,
        ...(basis !== undefined ? { basis } : {}),
      });
    const update = async (id: string, body: unknown) => {
      const call = routeArgs(mind, {
        path: `/api/memory/v2/facts/${id}/update`,
        method: "POST",
        profile: bot.id,
        body,
      });
      await memoryV2Routes(call.args);
      return { status: call.status(), body: call.body() as Record<string, unknown> };
    };
    const city = await write("Harry lives in Jakarta");
    const changed = await update(city.id, { op: "change", text: "Harry lives in Bandung" });
    expect(changed.status).toBe(200);
    const birthday = await write("Harry's birthday is 3 May");
    expect(
      (await update(birthday.id, { op: "correct", text: "Harry's birthday is 5 March" })).status,
    ).toBe(200);
    const job = await write("Harry works at Paprika");
    expect((await update(job.id, { op: "end" })).body.retired).toBe(true);
    const guess = await write("Harry likes jazz", "inferred");
    expect((await update(guess.id, { op: "confirm" })).body.confirmations).toBe(1);
    const facts = await mind.memory.readFacts("harry", bot.id);
    const byText = (text: string) => facts.find((fact) => fact.text === text);
    expect(byText("Harry lives in Jakarta")?.retired).toBe("changed");
    expect(byText("Harry's birthday is 3 May")?.retired).toBe("corrected");
    expect(byText("Harry works at Paprika")?.retired).toBe("ended");
    expect(byText("Harry likes jazz")?.basis).toBe("confirmed");
    expect((await update("nope", { op: "end" })).status).toBe(404);
    expect((await update(city.id, { op: "explode" })).status).toBe(400);
    expect((await update(city.id, { op: "end" })).status).toBe(409);
    await handle.close();
  });
});

describe("GET /api/memory/v2 provenance", () => {
  it("maps a fact's source conversation to the chat it was learned in", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { mind } = handle;
    const bot = await mind.profiles.create("harry", { name: "Keeper", onboard: false });
    const main = await mind.profiles.ensureMain("harry", bot.id);
    const { Effect } = await import("effect");
    const conversation = await Effect.runPromise(
      mind.converse.ensure(await mind.profiles.keyForSession("harry", main.id)),
    );
    await mind.memory.writeV2({
      owner: "harry",
      profileId: bot.id,
      scope: "profile",
      writer: bot.id,
      text: "Harry takes his coffee black",
      conversation: String(conversation.id),
    });
    const read = routeArgs(mind, { path: "/api/memory/v2", profile: bot.id });
    await memoryV2Routes(read.args);
    const body = read.body() as {
      facts: { source: { conversation: string | null } }[];
      chats: Record<string, { sessionId: string; kind: string }>;
    };
    const source = body.facts[0]?.source.conversation ?? "";
    expect(body.chats[source]).toMatchObject({ sessionId: main.id, kind: "main" });
    await handle.close();
  });
});
