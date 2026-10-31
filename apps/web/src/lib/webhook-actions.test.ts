/**
 * Bug 4: the webhook row re-reads the list after a test fire and after a new
 * token, and the Routines screen re-reads on window focus, so counts are
 * current without a page reload.
 */
import { describe, expect, it, vi } from "vite-plus/test";
import type { WebhookInfo } from "@spriessen/contracts";
import { issueToken, sendTest } from "./webhook-actions.ts";
import { reloadOnFocus } from "./reload-on-focus.ts";

const HOOK: WebhookInfo = {
  id: "hook-test-1",
  sessionId: "session-test-1",
  profile: "bot-test-1",
  name: "Test hook",
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
};

/** A fake server (a test fire bumps the count) and the screen's last-read list. */
const fakeServer = () => {
  let stored = HOOK;
  const client = {
    testWebhook: vi.fn(async () => {
      stored = { ...stored, fireCount: stored.fireCount + 1, lastFiredAt: 2 };
      return { accepted: true };
    }),
    rotateWebhookToken: vi.fn(async () => ({ ...stored, token: "fresh-token" })),
  };
  const screen = { hook: HOOK };
  const load = vi.fn(async () => {
    screen.hook = stored;
  });
  return { client, load, screen };
};

describe("webhook row refresh (bug 4)", () => {
  it("re-reads the list after a test fire, so the row shows the new count", async () => {
    const s = fakeServer();
    expect(s.screen.hook.fireCount).toBe(0);
    const result = await sendTest(s.client as never, HOOK.id, "{}", s.load);
    expect(result).toBe("Accepted: the payload matches.");
    expect(s.load).toHaveBeenCalledTimes(1);
    expect(s.screen.hook.fireCount).toBe(1);
  });

  it("does not re-read when the payload never reached the server", async () => {
    const s = fakeServer();
    const result = await sendTest(s.client as never, HOOK.id, "{not json", s.load);
    expect(result).not.toBe("Accepted: the payload matches.");
    expect(s.client.testWebhook).not.toHaveBeenCalled();
    expect(s.load).not.toHaveBeenCalled();
  });

  it("re-reads the list after a new token and still returns the token to show once", async () => {
    const s = fakeServer();
    expect(await issueToken(s.client as never, HOOK.id, s.load)).toBe("fresh-token");
    expect(s.load).toHaveBeenCalledTimes(1);
  });

  it("re-reads on window focus until cleaned up", () => {
    const target = new EventTarget();
    const reload = vi.fn();
    const cleanup = reloadOnFocus(target, reload);
    target.dispatchEvent(new Event("focus"));
    expect(reload).toHaveBeenCalledTimes(1);
    cleanup();
    target.dispatchEvent(new Event("focus"));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
