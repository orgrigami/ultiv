/**
 * Webhook threads over the real REST ingress (throwaway stores): payloads of
 * one outside thread open ONE chat titled from the payload and continue it;
 * a sender off the allow list never opens a chat (receipted "ignored") and
 * only adds context, as a note, to a thread that already has one.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { findWebhook, listRoutineEvents, openMind } from "@spriessen/mind";
import { createRestHandler } from "../rest.ts";
import { AuthStore } from "../auth/store.ts";
import { signInForTest } from "../auth/test-auth.ts";
import { closeWebhookPump } from "../webhooks.ts";
import { readView, TRANSCRIPT_WINDOW } from "@spriessen/mind";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-hook-threads-"));
process.env["AUTH_DIR"] = join(scratch, "auth");
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");

let handle: Awaited<ReturnType<typeof openMind>>;
let server: Server;
let base = "";
let hook = { id: "", token: "" };
let botId = "";

beforeAll(async () => {
  handle = await openMind({ storage: new MemoryStorage() });
  const bot = await handle.mind.profiles.create("owner", { name: "Triage", onboard: false });
  botId = bot.id;
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
  base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  const cookie = await signInForTest(base);
  const created = await fetch(`${base}/api/webhooks`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      sessionId,
      name: "GitHub",
      threadKey: "issue.number",
      threadTitle: "issue.title",
      senders: { path: "sender.login", allow: ["ana"] },
    }),
  });
  hook = (await created.json()) as { id: string; token: string };
});

afterAll(async () => {
  closeWebhookPump(handle.mind);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

const post = async (payload: unknown): Promise<{ status: number; eventId: string }> => {
  const response = await fetch(`${base}/hooks/${hook.id}?token=${hook.token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = (await response.json()) as { eventId?: string };
  return { status: response.status, eventId: json.eventId ?? "" };
};

const issue = (number: number, login: string) => ({
  issue: { number, title: `Issue ${number} title` },
  sender: { login },
});

const threadsOf = async () => (await findWebhook(handle.mind.converse, hook.id))?.threads ?? [];

describe("webhook threads", () => {
  it("a stranger cannot open a chat: ignored, receipted", async () => {
    const sent = await post(issue(7, "mallory"));
    expect(sent.status).toBe(200);
    expect(await threadsOf()).toEqual([]);
    const events = await listRoutineEvents(handle.mind.converse, { routineId: hook.id });
    expect(events.find((event) => event.id === sent.eventId)?.status).toBe("ignored");
  });

  it("one thread, one chat, titled from the payload, continued by later payloads", async () => {
    await post(issue(12, "Ana"));
    await post(issue(12, "ana"));
    await post(issue(13, "ana"));
    const threads = await threadsOf();
    expect(threads.map((thread) => thread.key).sort()).toEqual(["12", "13"]);
    const chats = await handle.mind.profiles.listSessions("owner", botId);
    const twelve = chats.find((chat) => chat.id === threads.find((t) => t.key === "12")?.sessionId);
    expect(twelve?.title).toBe("Issue 12 title");
  });

  it("a stranger on a followed thread only adds a context note to its chat", async () => {
    const before = await threadsOf();
    await post(issue(12, "mallory"));
    expect((await threadsOf()).length).toBe(before.length);
    const chat = before.find((thread) => thread.key === "12")!.sessionId;
    const row = await handle.mind.profiles.rowOf(chat);
    const conversation = await Effect.runPromise(
      handle.mind.converse.ensure(await handle.mind.profiles.keyOfRow(row!)),
    );
    const state = await readView(conversation, TRANSCRIPT_WINDOW);
    const text = JSON.stringify(state.entries ?? []);
    expect(text).toContain("context only: this sender may not ask you for work");
    expect(text).toContain("ultiv.webhook-context");
  });
});

describe("a webhook in trial mode", () => {
  it("runs an allowed payload as a trial: no chat opens, the trial lands on the webhook", async () => {
    const cookie = await signInForTest(base);
    const sessionId = (await handle.mind.profiles.ensureMain("owner", botId)).id;
    const created = await fetch(`${base}/api/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ sessionId, threadKey: "issue.number", trial: true }),
    });
    const trialHook = (await created.json()) as { id: string; token: string; trial?: boolean };
    expect(trialHook.trial).toBe(true);
    const sent = await fetch(`${base}/hooks/${trialHook.id}?token=${trialHook.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(issue(99, "ana")),
    });
    expect(sent.status).toBe(200);
    let trials: unknown[] = [];
    // Offline the trial turn fails (no model); the failure is the trial's record.
    for (let n = 0; n < 150 && trials.length === 0; n += 1) {
      trials = (await findWebhook(handle.mind.converse, trialHook.id))?.trials ?? [];
      if (trials.length === 0) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(trials).toHaveLength(1);
    expect((await findWebhook(handle.mind.converse, trialHook.id))?.threads ?? []).toEqual([]);
    const live = await fetch(`${base}/api/webhooks/${trialHook.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ trial: false }),
    });
    expect(((await live.json()) as { trial?: boolean }).trial).toBeUndefined();
  }, 30_000);
});
