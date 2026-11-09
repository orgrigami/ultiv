/**
 * The opt-in REAL takeover wiring: a real mind (memory storage), a real
 * bot's chat conversation, a takeover opened on the REAL registry the
 * entity wired, and the cast routes over the REAL home VM — chromium boots,
 * frames stream through the REST SSE route, and an act POST reaches the
 * page. The row's own act/shot closures stay fake (they are the selector
 * path); the cast is the production path end to end. `SPRIESSEN_REAL_VM=1
 * vp test --run apps/server/src/rest/takeover-live-vm.test.ts`; the bot's
 * home VM is the real sandbox backend, so this machine needs the runtime.
 * Never touches a live server or a live VM.
 */
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "@spriessen/mind";
import { createRestHandler } from "../rest.ts";
import { AuthStore } from "../auth/store.ts";
import { signInForTest } from "../auth/test-auth.ts";

const REAL = process.env.SPRIESSEN_REAL_VM === "1";
const suite = REAL ? describe : describe.skip;
const T = 300_000;

let handle: Awaited<ReturnType<typeof openMind>>;
let server: Server;
let base = "";
let cookie = "";
let rowId = "";

beforeAll(async () => {
  const scratch = mkdtempSync(join(tmpdir(), "spriessen-takeover-live-"));
  process.env.ARTIFACTS_DIR = join(scratch, "artifacts");
  handle = await openMind({ storage: new MemoryStorage(), vault: { dir: join(scratch, "vault") } });
  const { mind } = handle;
  const owner = process.env.OWNER_ID ?? "owner";
  const bot = await mind.profiles.create(owner, { name: "Driver" });
  const session = await mind.profiles.ensureMain(owner, bot.id);
  const conversationId = String(
    await Effect.runPromise(mind.converse.conversationIdOf(await mind.profiles.keyOfRow(session))),
  );
  expect(conversationId).not.toBe("");
  const rest = createRestHandler({
    mind,
    scheduler: { refresh: async () => {}, stop: () => {} },
    auth: new AuthStore(),
  });
  server = createServer(rest);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  cookie = await signInForTest(base);
  if (mind.browserTakeovers === undefined || mind.browserCasts === undefined) {
    throw new Error("the mind did not wire the browser facility");
  }
  const row = await mind.browserTakeovers.open({
    conversationId,
    reason: "the sign-in needs you",
    act: async () => ({ ok: true, png: "", url: "", title: "", text: "", error: null }),
  });
  rowId = row.id;
}, T);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await handle.close().catch(() => undefined);
}, T);

const readSse = async (
  path: string,
  wanted: readonly string[],
  ms: number,
): Promise<Record<string, unknown>> => {
  const controller = new AbortController();
  const response = await fetch(`${base}${path}`, {
    headers: { cookie },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("no stream body");
  const found: Record<string, unknown> = {};
  let text = "";
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString("utf-8");
      for (const part of text.split("\n\n")) {
        const event = /^event: (.+)$/m.exec(part);
        const data = /^data: (.+)$/m.exec(part);
        if (event !== null && data !== null && wanted.includes(event[1] ?? "")) {
          found[event[1] ?? ""] = JSON.parse(data[1] ?? "{}");
        }
      }
      if (wanted.every((kind) => found[kind] !== undefined)) break;
    }
  } catch {
    // The deadline abort: return what arrived.
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return found;
};

suite("the takeover cast over a real home VM", () => {
  it(
    "lists the ask, streams real frames, and takes a real act",
    async () => {
      const list = await fetch(`${base}/api/browser/takeover`, { headers: { cookie } });
      const body = (await list.json()) as { takeovers: { id: string; botName: string }[] };
      expect(body.takeovers.some((row) => row.id === rowId && row.botName === "Driver")).toBe(true);

      // Frames flow: the cast boots the home VM's chromium itself.
      const events = readSse(`/api/browser/takeover/${rowId}/cast`, ["ready", "frame"], 120_000);
      const seen = await events;
      expect(seen.ready).toEqual({ ok: true });
      const frame = seen.frame as { w: number; h: number; data: string } | undefined;
      expect(frame?.w).toBe(1280);
      expect(frame?.h).toBe(800);
      expect(frame?.data).toMatch(/^\/9j\//);

      // An act rides the same cast: the POST lands, no error event follows.
      const act = await fetch(`${base}/api/browser/takeover/${rowId}/cast/act`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ a: "nav", url: "about:blank" }),
      });
      expect(act.status).toBe(200);
    },
    T,
  );
});

it.skipIf(REAL)(
  "real takeover wiring: NOT VERIFIED in this run (set SPRIESSEN_REAL_VM=1 to run it)",
  () => {
    expect(REAL).toBe(false);
  },
);
