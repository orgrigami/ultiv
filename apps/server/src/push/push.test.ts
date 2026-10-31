import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { TaskInfo } from "@spreissen/contracts";
import { vapidConfig } from "./config.ts";
import { isPushEndpoint } from "./endpoint.ts";
import { approvalPayload, routinePayload, taskPayload } from "./events.ts";
import { COLLAPSE_WINDOW_MS, MAX_PER_MINUTE, makeNotifier, topicOf } from "./notifier.ts";
import { makePresence, PRESENCE_WINDOW_MS } from "./presence.ts";
import { makePushStore, type PushSubscriptionRecord } from "./store.ts";

const KEYS = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA", auth: "tBHItJI5svbpez7KI4CCXg" };
const FCM = "https://fcm.googleapis.com/fcm/send/abc123";
const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "spreissen-push-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("push endpoint guard", () => {
  it("accepts the browser push services over https only", () => {
    expect(isPushEndpoint(FCM)).toBe(true);
    expect(isPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(isPushEndpoint("https://web.push.apple.com/QK7")).toBe(true);
    expect(isPushEndpoint("http://fcm.googleapis.com/x")).toBe(false);
    expect(isPushEndpoint("https://127.0.0.1/x")).toBe(false);
    expect(isPushEndpoint("https://169.254.169.254/latest")).toBe(false);
    expect(isPushEndpoint("https://fcm.googleapis.com.evil.test/x")).toBe(false);
    expect(isPushEndpoint("https://evilfcm.googleapis.com.test/x")).toBe(false);
    expect(isPushEndpoint("https://user:pw@fcm.googleapis.com/x")).toBe(false);
    expect(isPushEndpoint("https://fcm.googleapis.com:8443/x")).toBe(false);
    expect(isPushEndpoint("not a url")).toBe(false);
  });
});

describe("push store", () => {
  it("keeps subscriptions per owner, validates them and writes 0600", () => {
    const dir = scratch();
    const store = makePushStore(dir);
    expect(store.add("harry", { endpoint: FCM, keys: KEYS })).toBeNull();
    expect(store.add("harry", { endpoint: FCM, keys: KEYS })).toBeNull(); // upsert
    expect(store.add("harry", { endpoint: "https://10.0.0.1/x", keys: KEYS })).toMatch(/endpoint/);
    expect(store.add("harry", { endpoint: FCM, keys: { p256dh: "x", auth: "<script>" } })).toMatch(
      /keys/,
    );
    expect(store.list("harry")).toHaveLength(1);
    expect(store.list("guest")).toEqual([]);
    expect(store.remove("guest", FCM)).toBe(false);
    expect(statSync(join(dir, "subscriptions.json")).mode & 0o777).toBe(0o600);
    expect(makePushStore(dir).list("harry")[0]?.endpoint).toBe(FCM);
    expect(store.remove("harry", FCM)).toBe(true);
    expect(store.list("harry")).toEqual([]);
  });
});

describe("presence", () => {
  it("is visible while any tab reported visible recently", () => {
    let now = 1_000;
    const presence = makePresence(() => now);
    expect(presence.isVisible("harry")).toBe(false);
    presence.report("harry", "tab-aaaaaa", true);
    presence.report("harry", "tab-bbbbbb", false);
    expect(presence.isVisible("harry")).toBe(true);
    expect(presence.isVisible("guest")).toBe(false);
    now += PRESENCE_WINDOW_MS + 1;
    expect(presence.isVisible("harry")).toBe(false);
    presence.report("harry", "tab-aaaaaa", true);
    presence.report("harry", "tab-aaaaaa", false);
    expect(presence.isVisible("harry")).toBe(false);
  });
});

const harness = () => {
  let now = 10_000;
  const sent: { endpoint: string; body: string; topic: string }[] = [];
  const store = makePushStore(scratch());
  store.add("harry", { endpoint: FCM, keys: KEYS });
  const presence = makePresence(() => now);
  let fail: number | null = null;
  const notifier = makeNotifier({
    store,
    presence,
    now: () => now,
    send: async (sub: PushSubscriptionRecord, body, options) => {
      if (fail !== null) throw Object.assign(new Error("gone"), { statusCode: fail });
      sent.push({ endpoint: sub.endpoint, body, topic: options.topic });
      return { statusCode: 201 };
    },
  });
  return {
    sent,
    store,
    presence,
    notifier,
    tick: (ms: number) => (now += ms),
    failWith: (status: number) => (fail = status),
  };
};

const PAYLOAD = { title: "Eve finished a task", body: "Report", url: "/c/s1", tag: "task:1" };

describe("notifier", () => {
  it("sends a short payload and collapses the same tag", async () => {
    const h = harness();
    expect(await h.notifier.notify("harry", PAYLOAD)).toBe("sent");
    expect(await h.notifier.notify("harry", PAYLOAD)).toBe("duplicate");
    h.tick(COLLAPSE_WINDOW_MS + 1);
    expect(await h.notifier.notify("harry", PAYLOAD)).toBe("sent");
    expect(h.sent).toHaveLength(2);
    expect(JSON.parse(h.sent[0]?.body ?? "{}")).toEqual(PAYLOAD);
    expect(h.sent[0]?.topic).toBe(topicOf("task:1"));
    expect(topicOf("task:1")).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(await h.notifier.notify("guest", PAYLOAD)).toBe("no-devices");
  });

  it("skips while the app is visible unless the owner asked", async () => {
    const h = harness();
    h.presence.report("harry", "tab-aaaaaa", true);
    expect(await h.notifier.notify("harry", PAYLOAD)).toBe("visible");
    expect(await h.notifier.notify("harry", PAYLOAD, { ignoreVisible: true })).toBe("sent");
  });

  it("rate-limits per owner and never opens an off-app URL", async () => {
    const h = harness();
    for (let i = 0; i < MAX_PER_MINUTE; i += 1) {
      const url = i === 0 ? "https://evil.test/phish" : "/c/s1";
      expect(await h.notifier.notify("harry", { ...PAYLOAD, tag: `t${i}`, url })).toBe("sent");
    }
    expect(await h.notifier.notify("harry", { ...PAYLOAD, tag: "late" })).toBe("rate-limited");
    expect(JSON.parse(h.sent[0]?.body ?? "{}").url).toBe("/");
  });

  it("prunes a subscription the push service says is gone", async () => {
    const h = harness();
    h.failWith(410);
    await h.notifier.notify("harry", PAYLOAD);
    expect(h.store.list("harry")).toEqual([]);
  });
});

describe("payloads", () => {
  const task = {
    id: "t1",
    sessionId: "s1",
    owner: "harry",
    conversationId: null,
    prompt: "secret prompt text that is long",
    status: "done",
    result: "the full result with sk_live_123",
    error: null,
    createdAt: 1,
    finishedAt: 2,
    title: "Compare flights",
  } satisfies TaskInfo;
  it("carry names and kinds, never results or tool input", () => {
    const done = taskPayload(task, "Eve");
    expect(done).toMatchObject({ title: "Eve finished a task", body: "Compare flights" });
    expect(done.url).toBe("/c/s1");
    expect(JSON.stringify(done)).not.toContain("sk_live");
    expect(taskPayload({ ...task, status: "failed" }, "Eve").title).toBe("Eve's task failed");
    const approval = approvalPayload("Eve", "http_request", "s1");
    expect(approval).toMatchObject({ url: "/c/s1", urgency: "high" });
    expect(routinePayload("Scout", "cron", "s 2").url).toBe("/c/s%202");
  });
});

describe("vapid config", () => {
  it("is off without both keys and keeps a valid subject", () => {
    expect(vapidConfig({ VAPID_PUBLIC_KEY: "a" })).toBeNull();
    const config = vapidConfig({
      VAPID_PUBLIC_KEY: "a",
      VAPID_PRIVATE_KEY: "b",
      VAPID_SUBJECT: "x",
    });
    expect(config?.subject).toMatch(/^mailto:/);
  });
});
