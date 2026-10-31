/**
 * The per-bot learning switch (Phase 1 slice 11) over the real REST handler:
 * default on, the owner turns it off with a policies patch and the bot's
 * conversations see it at once; another owner can't flip it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "@spriessen/mind";
import { createRestHandler } from "../rest.ts";

const scratch = mkdtempSync(join(tmpdir(), "spreissen-learn-switch-"));
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");

let handle: Awaited<ReturnType<typeof openMind>>;
let server: Server;
let base = "";
let bot = "";
let conversation = "";

const call = async (user: string, method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-spreissen-user": user },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: (await response.json()) as any };
};

const learnsNow = (): boolean | undefined =>
  handle.mind.profiles.profileOf(conversation)?.policies.learnSkills;

beforeAll(async () => {
  handle = await openMind({ storage: new MemoryStorage() });
  bot = (await handle.mind.profiles.create("owner-a", { name: "Learner", onboard: false })).id;
  const main = await handle.mind.profiles.ensureMain("owner-a", bot);
  conversation = String(
    await Effect.runPromise(
      handle.mind.converse.conversationIdOf(await handle.mind.profiles.keyOfRow(main)),
    ),
  );
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

describe("learning switch", () => {
  it("is on by default and the owner turns it off and on", async () => {
    expect(learnsNow()).not.toBe(false);
    const off = await call("owner-a", "PATCH", `/api/profiles/${bot}`, {
      policies: { learnSkills: false },
    });
    expect(off.status).toBe(200);
    expect(off.json.policies.learnSkills).toBe(false);
    expect(off.json.policies.approvalMode).toBe("manual");
    expect(learnsNow()).toBe(false);
    const on = await call("owner-a", "PATCH", `/api/profiles/${bot}`, {
      policies: { learnSkills: true },
    });
    expect(on.json.policies.learnSkills).toBe(true);
    expect(learnsNow()).toBe(true);
  });

  it("wrong person can't: another owner's patch is refused and changes nothing", async () => {
    const before = learnsNow();
    const other = await call("owner-b", "PATCH", `/api/profiles/${bot}`, {
      policies: { learnSkills: false },
    });
    expect(other.status).toBe(404);
    expect(learnsNow()).toBe(before);
  });
});
