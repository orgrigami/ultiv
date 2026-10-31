/**
 * WebSocket auth: an upgrade without a valid session is refused; with one it
 * connects; an expired session is dropped; and a session that belongs to a
 * DIFFERENT install (the Phase 0 gap: someone who knows another owner's
 * session id) is refused too. Uses the real stack on an ephemeral port.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import WebSocket from "ws";
import { buildStack } from "./main.ts";
import { SESSION_TTL_MS } from "./auth/config.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-ws-auth-"));
process.env["AUTH_DIR"] = join(scratch, "auth");
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");
process.env["MODELS_DEV_URL"] = "off";

let stack: Awaited<ReturnType<typeof buildStack>>;
let base = "";
let cookie = "";

const wsProbe = (extraCookie: string | undefined): Promise<"open" | "refused"> =>
  new Promise((resolve) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/chord`,
      extraCookie !== undefined ? { headers: { cookie: extraCookie } } : {},
    );
    const settle = (outcome: "open" | "refused"): void => {
      socket.terminate();
      resolve(outcome);
    };
    socket.on("open", () => settle("open"));
    socket.on("error", () => settle("refused"));
    socket.on("unexpected-response", () => settle("refused"));
  });

let port = 0;
/** What an anonymous loopback socket got BEFORE any passcode existed. */
let beforeSetup: "open" | "refused" = "open";

beforeAll(async () => {
  stack = await buildStack({
    storage: new MemoryStorage(),
    vault: { dir: join(scratch, "vault") },
  });
  // buildStack already wired the upgrade handler onto its own http server.
  await new Promise<void>((resolve, reject) => {
    stack.http.once("listening", resolve);
    stack.http.once("error", reject);
    stack.http.listen(0, "127.0.0.1");
  });
  const address = stack.http.address();
  port = typeof address === "object" && address !== null ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
  beforeSetup = await wsProbe(undefined);
  const set = await fetch(`${base}/api/auth/passcode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passcode: "ws-auth-passcode" }),
  });
  cookie = set.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect(cookie).not.toBe("");
});

afterAll(async () => {
  await stack.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("websocket auth", () => {
  it("refuses an anonymous loopback socket even before a passcode exists", () => {
    expect(beforeSetup).toBe("refused");
  });

  it("refuses an upgrade without a session and accepts one with it", async () => {
    expect(await wsProbe(undefined)).toBe("refused");
    expect(await wsProbe("spriessen_session=not-a-real-session")).toBe("refused");
    expect(await wsProbe(cookie)).toBe("open");
  });

  it("reconnects after sign-out and a fresh sign-in", async () => {
    expect(await wsProbe(cookie)).toBe("open");
    // Sign this session out; the old cookie is dead for sockets too.
    await fetch(`${base}/api/auth/sign-out`, { method: "POST", headers: { cookie } });
    expect(await wsProbe(cookie)).toBe("refused");
    const again = await fetch(`${base}/api/auth/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: "ws-auth-passcode" }),
    });
    expect(again.status).toBe(200);
    const fresh = again.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(fresh).not.toBe("");
    expect(await wsProbe(fresh)).toBe("open");
  });

  it("drops an expired session", async () => {
    // Backdate it inside the store file, as idle time would.
    const file = join(process.env["AUTH_DIR"] ?? "", "sessions.json");
    const rows = JSON.parse(readFileSync(file, "utf8")) as Record<string, { lastSeenAt: number }>;
    const realId = Object.keys(rows)[0] ?? "";
    rows[realId] = { lastSeenAt: Date.now() - SESSION_TTL_MS - 1000 };
    writeFileSync(file, JSON.stringify(rows));
    expect(await wsProbe(`spriessen_session=${realId}`)).toBe("refused");
    // REST agrees with the socket.
    const rest = await fetch(`${base}/api/sessions`, {
      headers: { cookie: `spriessen_session=${realId}` },
    });
    expect(rest.status).toBe(401);
  });
});
