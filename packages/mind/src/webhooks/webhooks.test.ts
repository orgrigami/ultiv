import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "../entity.ts";
import { checkWebhookPayload, validateWebhookSchema, webhooksService } from "./webhooks.ts";
import { webhookTools } from "./tools.ts";

describe("Webhooks faculty (offline, MemoryStorage)", () => {
  it("refuses broken schemas at creation and accepts usable ones", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { converse, profiles } = handle.mind;
    const bot = await profiles.create("harry", { name: "Edison" });
    const main = await profiles.ensureMain("harry", bot.id);
    const webhooks = webhooksService({ converse, profiles });

    expect(validateWebhookSchema(null).ok).toBe(true);
    expect(validateWebhookSchema({ type: "object" }).ok).toBe(true);
    expect(validateWebhookSchema("nope").ok).toBe(false);
    expect(validateWebhookSchema(42).ok).toBe(false);
    // A schema nothing can satisfy is "usable" but hostile — creation keeps
    // it (the author's choice) while the test-fire surfaces the behavior.
    const impossible = webhooks.create({
      sessionId: main.id,
      schema: { type: "string" },
    });
    await expect(impossible).resolves.toMatchObject({ schema: { type: "string" } });

    const plain = await webhooks.create({ sessionId: main.id, name: "raw door" });
    expect(plain.token).toMatch(/[0-9a-f-]{36}/);
    expect(plain.schema).toBeNull();
    expect(plain.accepted).toBe(0);
    await handle.close();
  });

  it("validates payloads against the authored schema", () => {
    const schema = {
      type: "object",
      required: ["event"],
      properties: { event: { type: "string" } },
    };
    expect(checkWebhookPayload(schema, { event: "deploy" }).ok).toBe(true);
    const miss = checkWebhookPayload(schema, { wrong: true });
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.detail.length).toBeGreaterThan(0);
    // Malformed values never throw out of the validator.
    expect(checkWebhookPayload(schema, "not even an object").ok).toBe(false);
    expect(checkWebhookPayload(null, { anything: 1 }).ok).toBe(true);
  });

  it("accounts rejects per class and retains the offending bodies", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { converse, profiles } = handle.mind;
    const bot = await profiles.create("harry", { name: "Edison" });
    const main = await profiles.ensureMain("harry", bot.id);
    const webhooks = webhooksService({ converse, profiles });
    const hook = await webhooks.create({ sessionId: main.id });

    await webhooks.recordReject(hook.id, {
      reason: "auth",
      detail: "bearer token mismatch",
      body: '{"stale":true}',
    });
    await webhooks.recordReject(hook.id, {
      reason: "schema",
      detail: "missing event",
      body: '{"wrong":1}',
    });

    const after = (await webhooks.list()).find((w) => w.id === hook.id);
    expect(after?.rejectedAuth).toBe(1);
    expect(after?.rejectedSchema).toBe(1);
    expect(after?.lastRejectReason).toBe("schema");
    expect(after?.recentRejects).toHaveLength(2);
    expect(after?.recentRejects[0]?.body).toBe('{"wrong":1}');

    await expect(webhooks.remove(hook.id)).resolves.toBe(true);
    await expect(webhooks.remove(hook.id)).resolves.toBe(false);
    await handle.close();
  });

  it("exposes create/list/remove as tools with counters, never tokens", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const mind = handle.mind;
    const { converse, profiles, webhooks, receipts } = mind;
    const bot = await profiles.create("harry", { name: "Edison" });
    const main = await profiles.ensureMain("harry", bot.id);
    const key = await profiles.keyForSession("harry", main.id);
    const conversation = await Effect.runPromise(converse.ensure(key));
    const conversationId = String(conversation.id);
    const api = { conversationId } as never;

    const [create, list, remove] = webhookTools(webhooks, receipts, profiles);
    if (create === undefined || list === undefined || remove === undefined) {
      throw new Error("missing webhook tools");
    }

    const created = await create.execute(
      { name: "deploys", schema: { type: "object" } },
      api,
      {} as never,
    );
    expect(created.isError).toBeUndefined();
    // The id is public (it is the URL); the TOKEN must never cross a
    // model-facing surface.
    const hookId = (created.structuredOutput as { id: string }).id;
    // Only a hash is stored, so no list carries a token, and the tool output
    // names no id-shaped value but the webhook's own id, and no hash.
    expect((await webhooks.list()).find((w) => w.id === hookId)?.token).toBeUndefined();
    const shown = JSON.stringify([created.output, created.structuredOutput]);
    const uuids =
      shown.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
    expect(uuids.every((value) => value === hookId)).toBe(true);
    expect(shown).not.toContain("sha256:");

    const listed = await list.execute({}, api, {} as never);
    const rows = listed.structuredOutput as { id: string; rejectedLast24h: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rejectedLast24h).toBe(0);

    const listedId = rows[0]?.id ?? "";
    const removed = await remove.execute({ id: listedId }, api, {} as never);
    expect((removed.structuredOutput as { removed: boolean }).removed).toBe(true);
    await handle.close();
  });
});
