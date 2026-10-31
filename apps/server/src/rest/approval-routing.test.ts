/**
 * Approval routing (slice 6): a department bot's card reaches that
 * department's admins (and the org owner), an org bot's card the org owner
 * and org admins — and no one else. The list and the decide path both route;
 * deciding a card never reads the chat.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { approversFor, openMind } from "@spriessen/mind";
import { createRestHandler } from "../rest.ts";
import { AuthStore } from "../auth/store.ts";
import { signInForTest } from "../auth/test-auth.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-approval-routing-"));
process.env["AUTH_DIR"] = join(scratch, "auth");
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");

let handle: Awaited<ReturnType<typeof openMind>>;
let server: Server;
let base = "";
let cookie = "";

const call = async (
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      cookie,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = raw;
  }
  return { status: response.status, json };
};

/** Ask the approval routes as a role actor, through the same handler code. */
const callAs = async (
  owner: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> => {
  const { approvalRoutes } = await import("./approvals.ts");
  let status = 0;
  let payload: unknown = null;
  const json = (code: number, out: unknown): void => {
    status = code;
    payload = out;
  };
  const url = new URL(path, "http://localhost");
  const args = {
    mind: handle.mind,
    scheduler: { refresh: async () => {}, stop: () => {} },
    req: { method } as never,
    res: {} as never,
    url,
    owner,
    path: url.pathname,
    json,
    readJson: async <T>() => (body === undefined ? {} : (JSON.parse(JSON.stringify(body)) as T)),
    readBody: async () => Buffer.from(body === undefined ? "" : JSON.stringify(body)),
  } as unknown as import("./types.ts").RouteArgs;
  await approvalRoutes(args);
  return { status, json: payload };
};

beforeAll(async () => {
  handle = await openMind({ storage: new MemoryStorage() });
  await handle.mind.org.ensureOrg("owner", "Personal", true);
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

describe("approversFor", () => {
  const members: { accountId: string; role: "owner" | "admin"; departmentId: string | null }[] = [
    { accountId: "owner-a", role: "owner", departmentId: null },
    { accountId: "admin-org", role: "admin", departmentId: null },
    { accountId: "admin-b", role: "admin", departmentId: "dept-b" },
    { accountId: "admin-c", role: "admin", departmentId: "dept-c" },
  ];

  it("a department bot's card reaches its admins and the org owner", () => {
    expect(
      approversFor(members, "owner-a", { kind: "department", departmentId: "dept-b" }),
    ).toEqual(["owner-a", "admin-b"]);
  });

  it("an org bot's card reaches the org owner and org admins", () => {
    expect(approversFor(members, "owner-a", { kind: "org" })).toEqual(["owner-a", "admin-org"]);
  });

  it("never another department's admin", () => {
    const who = approversFor(members, "owner-a", { kind: "department", departmentId: "dept-c" });
    expect(who).toContain("admin-c");
    expect(who).not.toContain("admin-b");
  });
});

describe("approval routing over REST", () => {
  let deptB = "";
  let deptC = "";
  beforeAll(async () => {
    deptB = (await handle.mind.org.createDepartment({ name: "RoutingB" }, "owner")).id;
    deptC = (await handle.mind.org.createDepartment({ name: "RoutingC" }, "owner")).id;
    await handle.mind.org.setMember({ accountId: "admin-b", role: "admin", departmentId: deptB });
    await handle.mind.org.setMember({ accountId: "admin-c", role: "admin", departmentId: deptC });
  });

  const pending = async (botId: string, conversationId: string, callId: string): Promise<void> => {
    // Fire without awaiting: the gate blocks until decided, parking the card.
    void Effect.runPromise(
      handle.mind.approvals.request(conversationId, callId, {
        callId,
        name: "bash",
        description: "run a script",
        input: { script: "echo hi" },
      }),
    ).catch(() => {});
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && handle.mind.approvals.pendingFor(conversationId).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    void botId;
  };

  /** The durable conversation id of a session row. */
  const conversationOf = async (sessionId: string): Promise<string> => {
    const row = await handle.mind.profiles.rowOf(sessionId);
    const key = row !== undefined ? await handle.mind.profiles.keyOfRow(row) : "";
    return String(await Effect.runPromise(handle.mind.converse.conversationIdOf(key as never)));
  };

  it("a department B card reaches B's admin and the owner, never C's admin", async () => {
    const bot = await handle.mind.profiles.create("owner", {
      name: "Bee",
      onboard: false,
      departmentId: deptB,
    });
    const chat = await handle.mind.profiles.ensureMain("owner", bot.id);
    const conversation = await conversationOf(chat.id);
    await pending(bot.id, conversation, "call-b1");
    const inbox = (await callAs("owner", "GET", "/api/approvals")).json as {
      conversationId: string;
    }[];
    expect(inbox.some((card) => card.conversationId === conversation)).toBe(true);
    // B's admin sees it; C's admin does not.
    const asB = (await callAs("admin-b", "GET", "/api/approvals")).json as {
      conversationId: string;
    }[];
    expect(asB.some((card) => card.conversationId === conversation)).toBe(true);
    const asC = (await callAs("admin-c", "GET", "/api/approvals")).json as {
      conversationId: string;
    }[];
    expect(asC.some((card) => card.conversationId === conversation)).toBe(false);
    // The owner may decide it; C's admin is refused like a foreign chat.
    const decided = await callAs("owner", "POST", `/api/approvals/${conversation}/call-b1`, {
      approved: true,
    });
    expect(decided.status).toBe(200);
    const refused = await callAs("admin-c", "POST", `/api/approvals/${conversation}/call-b1`, {
      approved: true,
    });
    expect(refused.status).toBe(403);
    expect(refused.json).toEqual({ error: "not your conversation" });
  });

  it("an org bot's card reaches the org owner and org admins, no department admin", async () => {
    await handle.mind.org.setMember({ accountId: "admin-org", role: "admin", departmentId: null });
    const bot = await handle.mind.profiles.create("owner", { name: "Orgy", onboard: false });
    const chat = await handle.mind.profiles.ensureMain("owner", bot.id);
    const conversation = await conversationOf(chat.id);
    await pending(bot.id, conversation, "call-o1");
    const asOrg = (await callAs("admin-org", "GET", "/api/approvals")).json as {
      conversationId: string;
    }[];
    expect(asOrg.some((card) => card.conversationId === conversation)).toBe(true);
    const asB = (await callAs("admin-b", "GET", "/api/approvals")).json as {
      conversationId: string;
    }[];
    expect(asB.some((card) => card.conversationId === conversation)).toBe(false);
    const decided = await callAs("admin-org", "POST", `/api/approvals/${conversation}/call-o1`, {
      approved: true,
    });
    expect(decided.status).toBe(200);
  });
});
