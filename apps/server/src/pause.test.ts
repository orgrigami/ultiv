/**
 * The global pause over the real REST surface: while on, a webhook payload
 * is acked (the sender walked away) but its receipt settles "held" and no
 * conversation is woken; after resume, the next payload delivers normally.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { listRoutineEvents, openMind, readView, TRANSCRIPT_WINDOW } from "@spriessen/mind";
import { createRestHandler } from "./rest.ts";
import { AuthStore } from "./auth/store.ts";
import { signInForTest } from "./auth/test-auth.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-pause-"));
process.env["AUTH_DIR"] = join(scratch, "auth");
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");

let handle: Awaited<ReturnType<typeof openMind>>;
let server: Server;
let port = 0;
let hookPath = "";
let cookie = "";
let conversationId = "";

beforeAll(async () => {
  handle = await openMind({ storage: new MemoryStorage() });
  const bot = await handle.mind.profiles.create("owner", { name: "Hooked" });
  const main = await handle.mind.profiles.ensureMain("owner", bot.id);
  const key = await handle.mind.profiles.keyOfRow(main);
  const cid = await Effect.runPromise(handle.mind.converse.conversationIdOf(key));
  conversationId = String(cid);
  const sessionId = main.id;
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
  cookie = await signInForTest(`http://127.0.0.1:${port}`);
  const created = await fetch(`http://127.0.0.1:${port}/api/webhooks`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ sessionId }),
  });
  const row = (await created.json()) as { id: string; token: string };
  hookPath = `/hooks/${row.id}?token=${row.token}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

const send = async (body: unknown): Promise<number> => {
  const reply = await fetch(`http://127.0.0.1:${port}${hookPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return reply.status;
};

/** The newest receipt for the webhook. */
const newestReceipt = async () =>
  (await listRoutineEvents(handle.mind.converse, { source: "webhook", limit: 1 }))[0];

const transcript = async (): Promise<string> => {
  const chat = await Effect.runPromise(handle.mind.converse.open(conversationId));
  const view = chat === undefined ? null : await readView(chat, TRANSCRIPT_WINDOW);
  return JSON.stringify(view?.entries ?? []);
};

describe("the global pause", () => {
  it("holds a webhook fire (acked, receipt held, nobody woken) and delivers after resume", async () => {
    expect(
      (await fetch(`http://127.0.0.1:${port}/api/settings/pause`, { headers: { cookie } })).status,
    ).toBe(200);
    const pause = await fetch(`http://127.0.0.1:${port}/api/settings/pause`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ paused: true }),
    });
    expect(((await pause.json()) as { paused: boolean }).paused).toBe(true);

    // The sender is acked as usual; the workspace holds the delivery.
    expect(await send({ hello: "paused" })).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 3500));
    const held = await newestReceipt();
    expect(held?.status).toBe("held");
    expect(held?.reason).toContain("paused");
    expect(await transcript()).not.toContain("hello");

    // Resume: the held fire does NOT replay; the next one delivers.
    await fetch(`http://127.0.0.1:${port}/api/settings/pause`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ paused: false }),
    });
    expect(await send({ hello: "again" })).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect((await newestReceipt())?.status).toBe("delivered");
    expect(await transcript()).not.toContain("paused");
    expect(await transcript()).toContain("again");
  }, 20000);
});
