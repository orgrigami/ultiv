/**
 * The audit trail's owner-level rows: sign-in (success and refusal),
 * passcode set, permission changes, vault reads, and an approval decision.
 * All read back through GET /api/audit?kind=... with the session cookie.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { openMind, questionTools } from "@spriessen/mind";
import { createRestHandler } from "../rest.ts";
import { AuthStore } from "../auth/store.ts";
import { signInForTest } from "../auth/test-auth.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-audit-rest-"));
process.env["AUTH_DIR"] = join(scratch, "auth");
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");
process.env["VAULT_KEY"] = "audit-test-vault-key";

let handle: Awaited<ReturnType<typeof openMind>>;
let server: Server;
let base = "";
let cookie = "";
let bot = "";
let conversation = "";

const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: (await response.json()) as any };
};

const kindRows = async (kind: string): Promise<any[]> =>
  (await call("GET", `/api/audit?kind=${kind}&limit=200`)).json;

beforeAll(async () => {
  handle = await openMind({ storage: new MemoryStorage() });
  bot = (await handle.mind.profiles.create("owner", { name: "Audited", onboard: false })).id;
  const main = await handle.mind.profiles.ensureMain("owner", bot);
  conversation = String(
    await Effect.runPromise(
      handle.mind.converse.conversationIdOf(await handle.mind.profiles.keyOfRow(main)),
    ),
  );
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
  cookie = await signInForTest(base);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("owner-level audit rows", () => {
  it("records the passcode set and the successful sign-in", async () => {
    expect((await kindRows("auth")).map((row) => row.name)).toContain("passcode-set");
    // A real sign-in (not just the bootstrap that set the passcode).
    const signedIn = await fetch(`${base}/api/auth/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: "test-passcode-1" }),
    });
    expect(signedIn.status).toBe(200);
    cookie = signedIn.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    const rows = await kindRows("auth");
    expect(rows.map((row) => row.name)).toContain("sign-in");
    expect(rows.find((row) => row.name === "sign-in")?.ok).toBe(true);
  });

  it("records a denied sign-in without the attempted passcode", async () => {
    const denied = await fetch(`${base}/api/auth/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: "secret-attempt-42" }),
    });
    expect(denied.status).toBe(401);
    const rows = await kindRows("auth");
    const row = rows.find((entry) => entry.name === "sign-in" && entry.ok === false);
    expect(row?.error).toContain("wrong passcode");
    expect(JSON.stringify(rows)).not.toContain("secret-attempt-42");
  });

  it("records a permission change when policies are patched", async () => {
    const patched = await call("PATCH", `/api/profiles/${bot}`, {
      policies: { approvalMode: "jev" },
    });
    expect(patched.status).toBe(200);
    const rows = await kindRows("permission");
    const row = rows.find((entry) => entry.profile === bot);
    expect(row?.name).toBe("permission-change");
    expect(row?.permission?.keys).toContain("approvalMode");
    await call("PATCH", `/api/profiles/${bot}`, { policies: { approvalMode: "manual" } });
  });

  it("records a vault read without the secret", async () => {
    const sealed = await call("POST", "/api/vault", {
      kind: "login",
      name: "Audited login",
      login: { url: "https://mail.example.com", username: "a@example.com", password: "hunter2" },
    });
    expect(sealed.status).toBe(200);
    expect((await call("GET", `/api/vault/${sealed.json.id}`)).status).toBe(200);
    const rows = await kindRows("vault");
    expect(rows.map((row) => row.name)).toContain("vault-read");
    expect(JSON.stringify(rows)).not.toContain("hunter2");
  });

  it("records an approval decision", async () => {
    const tool = questionTools({
      profiles: handle.mind.profiles,
      approvals: handle.mind.approvals,
      audit: handle.mind.audit,
    })[0];
    if (tool === undefined) throw new Error("missing ask_user_question");
    const callId = "audit-q1";
    void tool.execute(
      { question: "Go ahead?", options: [{ label: "Yes" }] } as never,
      { conversationId: conversation, callId } as never,
      {} as never,
    );
    let waiting = false;
    for (let i = 0; i < 200 && !waiting; i += 1) {
      waiting = handle.mind.approvals.pendingFor(conversation).length > 0;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const decided = await call("POST", `/api/approvals/${conversation}/${callId}`, {
      approved: true,
      input: { answer: "Yes" },
    });
    expect(decided.status).toBe(200);
    const approvals = await call("GET", "/api/audit?limit=200");
    const row = (approvals.json as any[]).find(
      (entry) => entry.kind === "approval" && entry.callId === callId,
    );
    expect(row?.ok).toBe(true);
    expect(row?.profile).toBe(bot);
  });
});
