/**
 * Webhook tokens are stored only as SHA-256 hashes: creation and rotation
 * hand the token back once, lists never carry it, and the startup migration
 * seals legacy plaintext rows so their URLs keep working (throwaway stores
 * only: MemoryStorage and a temp-dir SQLite file).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openMind } from "../entity.ts";
import {
  hashWebhookToken,
  listWebhooks,
  rotateWebhookToken,
  sealWebhookTokens,
  verifyWebhookToken,
  WebhooksDoc,
  type StoredWebhook,
} from "./webhooks.ts";

const LEGACY_TOKEN = "legacy-plaintext-0f9e8d7c";

const open = async (storage: Storage = new MemoryStorage()) => {
  const handle = await openMind({ storage });
  const bot = await handle.mind.profiles.create("owner-a", { name: "Hooked" });
  const main = await handle.mind.profiles.ensureMain("owner-a", bot.id);
  return { handle, mind: handle.mind, sessionId: main.id };
};

const stored = async (converse: Parameters<typeof listWebhooks>[0]): Promise<StoredWebhook[]> =>
  (await Effect.runPromise(converse.docs.snapshot(WebhooksDoc)))?.items ?? [];

/** A row as the pre-hashing code wrote it: plaintext `token`, no hash. */
const writeLegacyRow = async (converse: Parameters<typeof listWebhooks>[0], sessionId: string) =>
  Effect.runPromise(
    converse.docs.commit(async (tx) => {
      const draft = await tx.doc(WebhooksDoc);
      draft.items = [
        ...draft.items,
        {
          id: "legacy-hook",
          token: LEGACY_TOKEN,
          sessionId,
          profile: "p",
          name: "old",
          schema: null,
          createdAt: 1,
          accepted: 0,
          rejectedAuth: 0,
          rejectedSchema: 0,
          rejectedRate: 0,
          rejectedSize: 0,
          fireCount: 0,
          lastFiredAt: null,
          lastRejectAt: null,
          lastRejectReason: null,
          recentRejects: [],
        },
      ];
    }),
  );

describe("webhook token hashing", () => {
  it("returns the token once at creation and stores only its hash", async () => {
    const { handle, mind, sessionId } = await open();
    const hook = await mind.webhooks.create({ sessionId, name: "door" });
    expect(hook.token).toMatch(/^[0-9a-f-]{36}$/);
    const listed = await listWebhooks(mind.converse);
    expect(JSON.stringify(listed)).not.toContain(hook.token);
    expect(listed[0]).not.toHaveProperty("token");
    expect(listed[0]).not.toHaveProperty("tokenHash");
    const [row] = await stored(mind.converse);
    expect(row?.token).toBeUndefined();
    expect(row?.tokenHash).toBe(hashWebhookToken(hook.token));
    expect(row?.tokenHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await verifyWebhookToken(mind.converse, hook.id, hook.token)).toBe(true);
    expect(await verifyWebhookToken(mind.converse, hook.id, "wrong")).toBe(false);
    expect(await verifyWebhookToken(mind.converse, hook.id, "")).toBe(false);
    expect(await verifyWebhookToken(mind.converse, "nope", hook.token)).toBe(false);
    await handle.close();
  });

  it("keeps the hash through counter updates and removal of other rows", async () => {
    const { handle, mind, sessionId } = await open();
    const keep = await mind.webhooks.create({ sessionId, name: "keep" });
    const drop = await mind.webhooks.create({ sessionId, name: "drop" });
    await mind.webhooks.recordReject(keep.id, { reason: "auth", detail: "x" });
    await mind.webhooks.remove(drop.id);
    expect(await verifyWebhookToken(mind.converse, keep.id, keep.token)).toBe(true);
    expect((await listWebhooks(mind.converse))[0]?.rejectedAuth).toBe(1);
    await handle.close();
  });

  it("rotates: the old token stops working, the new one works", async () => {
    const { handle, mind, sessionId } = await open();
    const hook = await mind.webhooks.create({ sessionId });
    const rotated = await rotateWebhookToken(mind.converse, hook.id);
    expect(rotated?.token).toBeDefined();
    expect(rotated?.token).not.toBe(hook.token);
    // The returned row outlives the transaction (it is serialised by REST).
    expect(JSON.parse(JSON.stringify(rotated))).toMatchObject({ id: hook.id, recentRejects: [] });
    expect(await verifyWebhookToken(mind.converse, hook.id, hook.token)).toBe(false);
    expect(await verifyWebhookToken(mind.converse, hook.id, rotated?.token ?? "")).toBe(true);
    expect(await rotateWebhookToken(mind.converse, "nope")).toBeUndefined();
    await handle.close();
  });

  it("seals legacy plaintext rows, keeps their URL working, and is repeatable", async () => {
    const { handle, mind, sessionId } = await open();
    await writeLegacyRow(mind.converse, sessionId);
    // Before the migration a legacy row still opens (and lists without its token).
    expect(await verifyWebhookToken(mind.converse, "legacy-hook", LEGACY_TOKEN)).toBe(true);
    expect(JSON.stringify(await listWebhooks(mind.converse))).not.toContain(LEGACY_TOKEN);
    expect(await sealWebhookTokens(mind.converse)).toBe(1);
    const [row] = await stored(mind.converse);
    expect(row?.token).toBeUndefined();
    expect(row?.tokenHash).toBe(hashWebhookToken(LEGACY_TOKEN));
    expect(await verifyWebhookToken(mind.converse, "legacy-hook", LEGACY_TOKEN)).toBe(true);
    expect(await verifyWebhookToken(mind.converse, "legacy-hook", "wrong")).toBe(false);
    // Running again changes nothing.
    expect(await sealWebhookTokens(mind.converse)).toBe(0);
    expect(await stored(mind.converse)).toEqual([row]);
    await handle.close();
  });

  it("leaves no plaintext token anywhere in a SQLite store after sealing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spreissen-hook-seal-"));
    const file = join(dir, "throwaway.sqlite");
    try {
      const { handle, mind, sessionId } = await open(await openNodeSqliteStorage(file));
      await writeLegacyRow(mind.converse, sessionId);
      const grep = (): number => {
        const db = new DatabaseSync(file, { readOnly: true });
        try {
          const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all() as { name: string }[];
          return tables.reduce((hits, { name }) => {
            const rows = db.prepare(`SELECT * FROM "${name}"`).all();
            return hits + rows.filter((r) => JSON.stringify(r).includes(LEGACY_TOKEN)).length;
          }, 0);
        } finally {
          db.close();
        }
      };
      expect(grep()).toBeGreaterThan(0);
      expect(await sealWebhookTokens(mind.converse)).toBe(1);
      expect(grep()).toBe(0);
      expect(await verifyWebhookToken(mind.converse, "legacy-hook", LEGACY_TOKEN)).toBe(true);
      await handle.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
