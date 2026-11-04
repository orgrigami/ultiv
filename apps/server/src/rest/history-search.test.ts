/**
 * GET /api/history/search over the real REST handler: hits grouped by the
 * bot whose chat said it, `bot` narrowing to one, another owner's or a
 * missing bot answering 404, and a too-short query answering empty.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { HistorySearch } from "@spriessen/contracts";
import { openMind } from "@spriessen/mind";
import { createRestHandler } from "../rest.ts";
import { AuthStore } from "../auth/store.ts";
import { signInForTest } from "../auth/test-auth.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-history-search-"));
process.env["AUTH_DIR"] = join(scratch, "auth");
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");

let handle: Awaited<ReturnType<typeof openMind>>;
let server: Server;
let base = "";
let cookie = "";
let edison = "";
let sari = "";

const say = async (profileId: string, text: string): Promise<void> => {
  const { converse, profiles } = handle.mind;
  const main = await profiles.ensureMain("owner", profileId);
  const conversation = await Effect.runPromise(
    converse.ensure(await profiles.keyForSession("owner", main.id)),
  );
  await Effect.runPromise(converse.interrupt(conversation));
  await Effect.runPromise(converse.submit(conversation, text));
};

const get = async (query: string): Promise<{ status: number; json: HistorySearch }> => {
  const response = await fetch(`${base}/api/history/search?${query}`, { headers: { cookie } });
  return { status: response.status, json: (await response.json()) as HistorySearch };
};

beforeAll(async () => {
  handle = await openMind({ storage: new MemoryStorage() });
  edison = (await handle.mind.profiles.create("owner", { name: "Edison", onboard: false })).id;
  sari = (await handle.mind.profiles.create("owner", { name: "Sari", onboard: false })).id;
  await say(edison, "the quarterly report is due on Friday");
  await say(sari, "Sari drafted the quarterly budget");
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

describe("conversation search over REST", () => {
  it("groups hits by the bot whose chat said it", async () => {
    const all = await get("q=quarterly");
    expect(all.status).toBe(200);
    expect(all.json.groups.map((group) => group.profile).sort()).toEqual([edison, sari].sort());
    const report = await get("q=report%20friday");
    expect(report.json.groups).toHaveLength(1);
    expect(report.json.groups[0]?.profile).toBe(edison);
    expect(report.json.groups[0]?.hits[0]?.snippet).toContain("quarterly report");
  });

  it("narrows to one bot, and a bot that isn't the owner's reads as missing", async () => {
    const one = await get(`q=quarterly&bot=${sari}`);
    expect(one.json.groups.map((group) => group.profile)).toEqual([sari]);
    expect((await get("q=quarterly&bot=nobody")).status).toBe(404);
  });

  it("answers a too-short query with nothing, and a bad day with 400", async () => {
    expect((await get("q=a")).json.groups).toEqual([]);
    expect((await get("q=report&since=2026-02-30")).status).toBe(400);
  });
});
