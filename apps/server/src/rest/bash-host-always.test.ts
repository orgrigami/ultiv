/**
 * "Always allow this exact command on this computer" for the host shell,
 * over the real REST handler and an offline mind: the server saves an exact
 * rule, the same script then runs without a card, any other script still
 * asks, and removing the rule in the bot's Access list brings the card back.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "@spreissen/mind";
import { createRestHandler } from "../rest.ts";

const scratch = mkdtempSync(join(tmpdir(), "spreissen-host-always-"));
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");

let handle: Awaited<ReturnType<typeof openMind>>;
let server: Server;
let base = "";
let bot = "";
let conversation = "";
let calls = 0;

const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-spreissen-user": "owner-a" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: (await response.json()) as any };
};

/** Ask the gate for one bash_host call: true/false if it settles alone, "card" if it parks. */
const gate = async (script: string) => {
  const callId = `c${++calls}`;
  const pending = Effect.runPromise(
    handle.mind.approvals.request(conversation, callId, {
      callId,
      name: "bash_host",
      input: { script },
    }),
  );
  for (let i = 0; i < 50; i++) {
    if (handle.mind.approvals.pendingFor(conversation).some((p) => p.callId === callId)) {
      return { outcome: "card" as const, callId, pending };
    }
    const settled = await Promise.race([pending, new Promise((r) => setTimeout(r, 5, "wait"))]);
    if (settled !== "wait") return { outcome: settled as boolean, callId, pending };
  }
  throw new Error("neither settled nor parked");
};

const autoApprove = async (): Promise<string[]> =>
  (await handle.mind.profiles.get("owner-a", bot))?.policies.autoApprove ?? [];

beforeAll(async () => {
  handle = await openMind({ storage: new MemoryStorage() });
  bot = (await handle.mind.profiles.create("owner-a", { name: "Host", onboard: false })).id;
  const main = await handle.mind.profiles.ensureMain("owner-a", bot);
  const cid = await Effect.runPromise(
    handle.mind.converse.conversationIdOf(await handle.mind.profiles.keyOfRow(main)),
  );
  conversation = String(cid);
  server = createServer(
    createRestHandler({
      mind: handle.mind,
      scheduler: { refresh: async () => {}, stop: () => {} },
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("bash_host: always allow this exact command", () => {
  it("saves an exact rule, matches only that script, and can be revoked", async () => {
    const first = await gate("git status");
    expect(first.outcome).toBe("card");
    const decided = await call("POST", `/api/approvals/${conversation}/${first.callId}`, {
      approved: true,
      always: true,
    });
    expect(decided.status).toBe(200);
    expect(decided.json.stored).toEqual(["bash_host:=git status"]);
    expect(await first.pending).toBe(true);
    expect(await autoApprove()).toEqual(["bash_host:=git status"]);

    // The same script runs without a card; anything else still asks.
    expect((await gate("git status")).outcome).toBe(true);
    for (const other of ["git status ", "git status; rm -rf /tmp/x", "git", "git push"]) {
      const asked = await gate(other);
      expect(asked.outcome, other).toBe("card");
      handle.mind.approvals.decide(conversation, asked.callId, false);
      expect(await asked.pending).toBe(false);
    }

    // The Access tab lists the rule and removes it with a policies patch.
    const listed = await call("GET", `/api/profiles`);
    const row = (listed.json as { id: string; policies: { autoApprove: string[] } }[]).find(
      (profile) => profile.id === bot,
    );
    expect(row?.policies.autoApprove).toEqual(["bash_host:=git status"]);
    const revoked = await call("PATCH", `/api/profiles/${bot}`, {
      policies: { ...row?.policies, autoApprove: [] },
    });
    expect(revoked.status).toBe(200);
    expect(await autoApprove()).toEqual([]);
    const again = await gate("git status");
    expect(again.outcome).toBe("card");
    handle.mind.approvals.decide(conversation, again.callId, false);
    await again.pending;
  });
});
