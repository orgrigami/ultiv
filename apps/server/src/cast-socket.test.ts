/**
 * The `/cast` socket against a hand-built mind (a real takeover registry and
 * cast hub over a FAKE broker stream): my ask drives — frames and events
 * come down, acts go up in order and reach the page; another owner's ask
 * closes like a missing one; a watch streams but never acts; a bad act is
 * refused without touching the page.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { WebSocket } from "ws";
import type { MindService } from "@spriessen/mind";
import {
  activeBrowsers,
  brokerClient,
  castSessions,
  takeoverRegistry,
  type ShellBackend,
  type ShellStream,
} from "@spriessen/ext";
import { castSockets } from "./cast-socket.ts";
import { OWNER_ID } from "./identity.ts";

const written: string[] = [];
const chunkers: ((chunk: { stdout: boolean; data: Uint8Array }) => void)[] = [];
const push = (line: string): void => {
  for (const emit of chunkers)
    emit({ stdout: true, data: new Uint8Array(Buffer.from(`${line}\n`)) });
};
const stream: ShellStream = {
  onChunk: (listener) => chunkers.push(listener),
  onExit: () => undefined,
  write: async (data) => {
    written.push(String(data));
  },
  stop: async () => undefined,
};
const backend: ShellBackend = {
  prepare: async () => undefined,
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  listFiles: async () => [],
  readFile: async () => new Uint8Array(),
  stream: async () => stream,
};

let server: Server;
let base = "";
let mine = "";
let theirs = "";

beforeAll(async () => {
  const takeovers = takeoverRegistry();
  const sessions = activeBrowsers();
  sessions.touch("bot-w", "conv-watch", { url: "https://example.test/", title: "Home" });
  const casts = castSessions({
    resolveOf: async () => ({ backend, bot: "bot-a" }),
    client: brokerClient(),
  });
  mine = (await takeovers.open({ conversationId: "conv-mine", reason: "sign in" })).id;
  theirs = (await takeovers.open({ conversationId: "conv-theirs", reason: "sign in" })).id;
  const mind = {
    browserTakeovers: takeovers,
    browserCasts: casts,
    browserSessions: sessions,
    profiles: {
      scopeOf: (conversationId: string) =>
        conversationId.endsWith("-theirs")
          ? { owner: "owner-b", profileId: "bot-b" }
          : { owner: OWNER_ID, profileId: "bot-a" },
    },
  } as unknown as MindService;
  const wss = castSockets(mind);
  server = createServer();
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (client) => wss.emit("connection", client, req));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `ws://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/cast`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Open a socket; collect its messages and how it closed. */
const open = (query: string) => {
  const client = new WebSocket(`${base}?${query}`);
  const seen: { event: string; data: Record<string, unknown> }[] = [];
  const closed = new Promise<number>((resolve) => client.on("close", (code) => resolve(code)));
  client.on("message", (raw) => seen.push(JSON.parse(String(raw)) as (typeof seen)[number]));
  const ready = new Promise<void>((resolve) => client.on("open", () => resolve()));
  return { client, seen, closed, ready };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

describe("the /cast socket", () => {
  it("drives my ask: events down, acts up in order", async () => {
    const socket = open(`takeover=${mine}&w=800&h=500`);
    await socket.ready;
    await settle();
    expect(JSON.parse(written[0] ?? "{}")).toMatchObject({
      op: "cast",
      drive: true,
      w: 800,
      h: 500,
    });
    push('{"t":"ready","drive":true}');
    push(
      '{"t":"frame","id":"f1","data":"/9j/4AAQ","w":800,"h":500,"url":"https://x.test/","title":"X","popup":false}',
    );
    push('{"t":"dialog","open":true,"type":"confirm","message":"Sure?"}');
    await settle();
    expect(socket.seen.map((row) => row.event)).toEqual(["ready", "frame", "dialog"]);
    socket.client.send(JSON.stringify({ a: "type", text: "hunter2" }));
    socket.client.send(JSON.stringify({ a: "key", key: "Enter" }));
    socket.client.send(JSON.stringify({ a: "nav", url: "javascript:alert(1)" }));
    await settle();
    expect(written.slice(-2)).toEqual([
      '{"a":"type","text":"hunter2"}\n',
      '{"a":"key","key":"Enter"}\n',
    ]);
    expect(socket.seen.at(-1)).toMatchObject({ event: "cast-error" });
    socket.client.close();
    await socket.closed;
  });

  it("closes another owner's ask exactly like a missing one", async () => {
    expect(await open(`takeover=${theirs}`).closed).toBe(4404);
    expect(await open("takeover=nope").closed).toBe(4404);
  });

  it("watches without ever acting", async () => {
    const socket = open("watch=conv-watch");
    await socket.ready;
    await settle();
    const before = written.length;
    socket.client.send(JSON.stringify({ a: "reload" }));
    await settle();
    expect(written.slice(before).some((line) => line.includes("reload"))).toBe(false);
    expect(socket.seen.at(-1)).toMatchObject({
      event: "cast-error",
      data: { error: "watching never touches the page" },
    });
    socket.client.close();
  });
});
