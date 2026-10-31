/**
 * Bug 4: the webhook row re-reads the list after a test fire and after a new
 * token, and the Routines screen re-reads on window focus, so counts are
 * current without a page reload.
 */
import { describe, expect, it, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WebhookInfo } from "@spreissen/contracts";
import { issueToken, sendTest, WebhookRow } from "./webhook-row.tsx";
import { reloadOnFocus } from "../lib/reload-on-focus.ts";

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

/** A fake server: a test fire bumps the count, a rotation issues a token. */
const fakeServer = () => {
  let hook = HOOK;
  const client = {
    testWebhook: vi.fn(async () => {
      hook = { ...hook, fireCount: hook.fireCount + 1, lastFiredAt: Date.now() };
      return { accepted: true };
    }),
    rotateWebhookToken: vi.fn(async () => ({ ...hook, token: "fresh-token" })),
  };
  // The screen's list as last read; `load` re-reads it.
  let shown = hook;
  const load = vi.fn(async () => {
    shown = hook;
  });
  const row = () =>
    renderToStaticMarkup(
      <WebhookRow hook={shown} bot="Test bot" onDelete={async () => {}} onChanged={load} />,
    );
  return { client, load, row };
};

describe("webhook row refresh (bug 4)", () => {
  it("shows the new fire count after a test fire, without a page reload", async () => {
    vi.stubGlobal("location", { origin: "http://test.invalid" });
    const s = fakeServer();
    expect(s.row()).toContain("Hasn&#x27;t run yet");
    const result = await sendTest(s.client as never, HOOK.id, "{}", s.load);
    expect(result).toBe("Accepted: the payload matches.");
    expect(s.load).toHaveBeenCalledTimes(1);
    expect(s.row()).toContain("Ran once");
    vi.unstubAllGlobals();
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
