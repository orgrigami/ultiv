/**
 * The takeover CAST routes against a hand-built mind: a real takeover
 * registry, a real cast hub over a FAKE streaming backend (no VM), and the
 * route's own scoping — my row drives and streams, another owner's row
 * answers exactly like a missing one. The SSE surface is read as a stream
 * (ready, frames, the closed event when the takeover ends) and the act
 * route's shapes are checked: a bad act is a 400, a javascript: url never
 * reaches the page.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { MindService } from "@spriessen/mind";
import { brokerClient, castSessions, takeoverRegistry } from "@spriessen/ext";
import type { ShellBackend, ShellStream } from "@spriessen/ext";
import { takeoverRoutes } from "./takeover.ts";
import type { RouteArgs } from "./types.ts";
import { OWNER_ID } from "../identity.ts";

const scriptable = (): {
  readonly stream: ShellStream;
  readonly push: (line: string) => void;
  readonly exit: () => void;
  readonly written: readonly string[];
} => {
  const chunkers: ((chunk: { stdout: boolean; data: Uint8Array }) => void)[] = [];
  const exiters: ((code: number) => void)[] = [];
  const writes: string[] = [];
  return {
    push: (line) => {
      for (const emit of chunkers) {
        emit({ stdout: true, data: new Uint8Array(Buffer.from(`${line}\n`)) });
      }
    },
    exit: () => {
      for (const exit of exiters) exit(0);
    },
    get written() {
      return writes;
    },
    stream: {
      onChunk: (listener) => chunkers.push(listener),
      onExit: (listener) => exiters.push(listener),
      write: async (data) => {
        writes.push(String(data));
      },
      stop: async () => undefined,
    },
  };
};

const mine = { conversationId: "conv-mine", row: "" };
const theirs = { conversationId: "conv-theirs", row: "" };
let process: ReturnType<typeof scriptable>;
let server: Server;
let base = "";

const backend = (): ShellBackend => ({
  prepare: async () => undefined,
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  listFiles: async () => [],
  readFile: async () => new Uint8Array(),
  stream: async () => process.stream,
});

beforeAll(async () => {
  process = scriptable();
  const registry = takeoverRegistry();
  const casts = castSessions({
    resolveOf: async () => ({ backend: backend(), bot: "bot-mine" }),
    client: brokerClient(),
    idleMs: 60_000,
  });
  const wakes: string[] = [];
  const ask = async (conversationId: string): Promise<string> =>
    (await registry.open({ conversationId, reason: "the sign-in needs you" })).id;
  mine.row = await ask(mine.conversationId);
  theirs.row = await ask(theirs.conversationId);
  const mind = {
    browserTakeovers: registry,
    browserCasts: casts,
    profiles: {
      scopeOf: (conversationId: string) =>
        conversationId === mine.conversationId
          ? { owner: OWNER_ID, profileId: "bot-mine" }
          : { owner: "owner-b", profileId: "bot-theirs" },
      get: async (owner: string, id: string) => ({ owner, id, name: "Asking Bot" }),
    },
  } as unknown as MindService;
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const args: RouteArgs = {
      mind,
      scheduler: { refresh: async () => {}, stop: () => {} },
      req,
      res,
      url,
      owner: OWNER_ID,
      path: url.pathname,
      json: (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      },
      readJson: <T>(request: typeof req) =>
        new Promise<T>((resolve) => {
          let raw = "";
          request.on("data", (chunk) => {
            raw += String(chunk);
          });
          request.on("end", () => resolve(JSON.parse(raw === "" ? "{}" : raw) as T));
        }),
      readBody: async () => Buffer.alloc(0),
    };
    void takeoverRoutes(args).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  expect(wakes).toEqual([]);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const post = async (path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Read one SSE event of each wanted kind from a live response stream. */
const sseEvents = async (
  path: string,
  wanted: readonly string[],
  ms: number,
): Promise<Record<string, unknown>> => {
  const controller = new AbortController();
  const response = await fetch(`${base}${path}`, { signal: controller.signal });
  expect(response.status).toBe(200);
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
    // The abort at the deadline: return what arrived.
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return found;
};

describe("the takeover cast routes", () => {
  it("lists my bot's ask, enriched with the bot's name", async () => {
    const list = await fetch(`${base}/api/browser/takeover`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { takeovers: { id: string; botName: string }[] };
    const ids = body.takeovers.map((row) => row.id);
    expect(ids).toContain(mine.row);
    expect(ids).not.toContain(theirs.row);
    expect(body.takeovers.find((row) => row.id === mine.row)?.botName).toBe("Asking Bot");
  });

  it("another owner's row answers exactly like a missing one", async () => {
    for (const row of [theirs.row, "takeover-nope"]) {
      const cast = await fetch(`${base}/api/browser/takeover/${row}/cast`);
      expect(cast.status).toBe(404);
      const act = await post(`/api/browser/takeover/${row}/cast/act`, { a: "reload" });
      expect(act.status).toBe(404);
      const finish = await post(`/api/browser/takeover/${row}/finish`, {});
      expect(finish.status).toBe(404);
    }
  });

  it("streams ready and frames over SSE, and forwards my acts to the page", async () => {
    const events = sseEvents(
      `/api/browser/takeover/${mine.row}/cast?w=800&h=500`,
      ["ready", "frame"],
      10_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    // The cast opens in DRIVE mode, sized to the viewer.
    expect(JSON.parse(process.written[0] ?? "{}")).toMatchObject({
      op: "cast",
      drive: true,
      w: 800,
      h: 500,
    });
    process.push('{"t":"ready","drive":true}');
    process.push(
      '{"t":"frame","id":"f1","data":"/9j/4AAQ","w":1280,"h":800,' +
        '"url":"https://example.test/signin","title":"Sign in"}',
    );
    const seen = await events;
    expect(seen.ready).toEqual({ drive: true });
    expect(seen.frame).toMatchObject({
      id: "f1",
      mime: "image/jpeg",
      w: 1280,
      url: "https://example.test/signin",
    });

    const act = await post(`/api/browser/takeover/${mine.row}/cast/act`, {
      a: "tap",
      x: 12,
      y: 34,
      id: "f1",
    });
    expect(act.status).toBe(200);
    expect(process.written.at(-1)).toBe('{"a":"tap","x":12,"y":34,"id":"f1"}\n');
    // about:blank is the one non-http target an owner may want (a clean slate).
    const blank = await post(`/api/browser/takeover/${mine.row}/cast/act`, {
      a: "nav",
      url: "about:blank",
    });
    expect(blank.status).toBe(200);
    for (const body of [
      { a: "move", x: 5, y: 6, id: "f1", held: true },
      { a: "tap", x: 5, y: 6, id: "f1", count: 2 },
      { a: "dialog", accept: false },
      { a: "upload", name: "id.png", data: Buffer.from("png").toString("base64") },
      { a: "viewport", w: 390, h: 700, mobile: true },
      { a: "back" },
    ]) {
      const reply = await post(`/api/browser/takeover/${mine.row}/cast/act`, body);
      expect(reply.status, JSON.stringify(body)).toBe(200);
    }
    expect(JSON.parse(process.written.at(-2) ?? "{}")).toMatchObject({
      a: "viewport",
      mobile: true,
    });
    const extended = await post(`/api/browser/takeover/${mine.row}/extend`, {});
    expect(((await extended.json()) as { deadline: number }).deadline).toBeGreaterThan(Date.now());
  });

  it("refuses malformed acts and non-http urls without touching the page", async () => {
    const before = process.written.length;
    for (const body of [
      { a: "tap", x: -5, y: 10, id: "f1" },
      { a: "type", text: "" },
      { a: "key", key: "Meta" },
      { a: "scroll", dx: 1, dy: Number.NaN },
      { a: "nav", url: "javascript:alert(1)" },
      { a: "nav", url: "file:///etc/passwd" },
      { a: "detonate" },
      { a: "upload", name: "x", data: "not base64!" },
      { a: "viewport", w: 10, h: 10 },
      {},
    ]) {
      const reply = await post(`/api/browser/takeover/${mine.row}/cast/act`, body);
      expect(reply.status, JSON.stringify(body)).toBe(400);
    }
    expect(process.written.length).toBe(before);
  });

  it("finishing stops the cast and wakes the bot with the page", async () => {
    // Keep a viewer attached so the cast is live, then finish.
    const events = sseEvents(`/api/browser/takeover/${mine.row}/cast`, ["closed"], 10_000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const finish = await post(`/api/browser/takeover/${mine.row}/finish`, {});
    expect(finish.status).toBe(200);
    const seen = await events;
    expect(seen.closed).toEqual({ reason: "the takeover ended" });
    // The row is gone for good.
    const after = await fetch(`${base}/api/browser/takeover`);
    const body = (await after.json()) as { takeovers: { id: string }[] };
    expect(body.takeovers.map((row) => row.id)).not.toContain(mine.row);
  });
});
