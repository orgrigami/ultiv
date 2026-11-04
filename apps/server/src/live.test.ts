/**
 * The live socket: an anonymous upgrade is refused, a signed-in client gets
 * a change signal within a second of a REST mutation, and a GET mutates
 * nothing. The frames carry a kind and a timestamp, never data.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import WebSocket from "ws";
import { buildStack } from "./main.ts";
import { coalesce, liveKindsFor, liveKindsForTool } from "./live.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-live-"));
process.env["AUTH_DIR"] = join(scratch, "auth");
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");
process.env["MODELS_DEV_URL"] = "off";

let stack: Awaited<ReturnType<typeof buildStack>>;
let base = "";
let port = 0;
let cookie = "";

beforeAll(async () => {
  stack = await buildStack({
    storage: new MemoryStorage(),
    vault: { dir: join(scratch, "vault") },
  });
  await new Promise<void>((resolve, reject) => {
    stack.http.once("listening", resolve);
    stack.http.once("error", reject);
    stack.http.listen(0, "127.0.0.1");
  });
  const address = stack.http.address();
  port = typeof address === "object" && address !== null ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
  const set = await fetch(`${base}/api/auth/passcode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passcode: "live-passcode-1" }),
  });
  cookie = set.headers.get("set-cookie")?.split(";")[0] ?? "";
});

afterAll(async () => {
  await stack.close();
  rmSync(scratch, { recursive: true, force: true });
});

const openLive = (withCookie: string | undefined): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/push`,
      withCookie !== undefined ? { headers: { cookie: withCookie } } : {},
    );
    socket.on("open", () => resolve(socket));
    socket.on("error", (cause) =>
      reject(cause instanceof Error ? cause : new Error(String(cause))),
    );
    socket.on("unexpected-response", (_req, response) =>
      reject(new Error(`refused: ${response.statusCode}`)),
    );
  });

/** The next frame, or null after `ms`. */
const nextFrame = (socket: WebSocket, ms = 1_000): Promise<string | null> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      resolve(null);
    }, ms);
    const onMessage = (data: unknown): void => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(String(data));
    };
    socket.on("message", onMessage);
  });

describe("the live socket", () => {
  it("refuses an anonymous upgrade", async () => {
    await expect(openLive(undefined)).rejects.toThrow(/401/);
    await expect(openLive("spriessen_session=bogus")).rejects.toThrow(/401/);
  });

  it("pushes a change signal within a second of a REST mutation", async () => {
    const socket = await openLive(cookie);
    // A bot mutation is a profiles+sessions signal (the client library turns
    // a connect into its own local `sync`; the server sends only changes).
    const made = await fetch(`${base}/api/profiles`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Live", onboard: false }),
    });
    expect(made.status).toBe(200);
    const frame = await nextFrame(socket);
    expect(frame).not.toBeNull();
    const parsed = JSON.parse(frame ?? "{}") as { kind: string; at: number };
    expect(["profiles", "sessions"]).toContain(parsed.kind);
    expect(typeof parsed.at).toBe("number");
    // A read signals nothing.
    await fetch(`${base}/api/profiles`, { headers: { cookie } });
    expect(await nextFrame(socket, 400)).toBeNull();
    socket.close();
  });
});

describe("coalesce", () => {
  it("collapses a burst into one trailing call", async () => {
    let calls = 0;
    const signal = coalesce(() => {
      calls += 1;
    }, 20);
    signal();
    signal();
    signal();
    expect(calls).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toBe(1);
    signal();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toBe(2);
  });
});

describe("bot-to-bot traffic", () => {
  it("signals mailbox without any REST call", async () => {
    const socket = await openLive(cookie);
    const { profiles, mailbox } = stack.mind;
    const a = await profiles.create("owner", { name: "Left", onboard: false });
    const b = await profiles.create("owner", { name: "Right", onboard: false });
    const kinds: string[] = [];
    socket.on("message", (data) => kinds.push(JSON.parse(String(data)).kind as string));
    await mailbox.send({
      owner: "owner",
      from: a.id,
      to: b.id,
      kind: "notify",
      body: "hello",
      origin: "tool",
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(kinds).toContain("mailbox");
    socket.close();
  });
});

describe("changes bots make through tools", () => {
  it("map a successful write tool to its slice, reads to nothing", () => {
    expect(liveKindsForTool("memory_write")).toEqual(["memory"]);
    expect(liveKindsForTool("skill_learn")).toEqual(["skills"]);
    expect(liveKindsForTool("schedule_set")).toEqual(["routines"]);
    expect(liveKindsForTool("sensor_remove")).toEqual(["routines"]);
    expect(liveKindsForTool("bot_create")).toEqual(["profiles", "sessions"]);
    expect(liveKindsForTool("memory_recall")).toEqual([]);
    expect(liveKindsForTool("skill_list")).toEqual([]);
    expect(liveKindsForTool("web_fetch")).toEqual([]);
  });

  it("signal the slice without any REST call", async () => {
    const socket = await openLive(cookie);
    const kinds: string[] = [];
    socket.on("message", (data) => kinds.push(JSON.parse(String(data)).kind as string));
    const call = {
      at: Date.now(),
      kind: "tool_call" as const,
      conversationId: "c1",
      profile: null,
      callId: "x",
      durationMs: 1,
      error: null,
    };
    stack.mind.audit.record({ ...call, name: "memory_write", ok: true });
    stack.mind.audit.record({ ...call, name: "skill_write", ok: false });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(kinds).toContain("memory");
    expect(kinds).not.toContain("skills");
    socket.close();
  });

  it("org changes over REST refresh the crew", () => {
    expect(liveKindsFor("PATCH", "/api/org")).toEqual(["profiles", "sessions"]);
    expect(liveKindsFor("POST", "/api/org/departments")).toEqual(["profiles", "sessions"]);
  });
});
