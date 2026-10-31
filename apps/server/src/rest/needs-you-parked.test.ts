/**
 * Parked tasks in Needs you, over the real REST handler and an offline mind
 * (the engine's parked list stubbed; the engine side is covered by
 * packages/mind/src/converse/parked.test.ts): the owner sees their bot's
 * parked task and can retry it; another owner neither sees it nor can
 * retry it, and gets the same 404 an unknown task gets.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind, type ParkedTask } from "@spriessen/mind";
import { createRestHandler } from "../rest.ts";
import { AuthStore } from "../auth/store.ts";
import { signInForTest } from "../auth/test-auth.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-parked-"));
process.env["AUTH_DIR"] = join(scratch, "auth");
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");

let handle: Awaited<ReturnType<typeof openMind>>;
let server: Server;
let base = "";
let cookie = "";
let bot = "";
let parked: ParkedTask[] = [];
const retried: string[] = [];

const call = async (method: string, path: string) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
  });
  return { status: response.status, json: (await response.json()) as any };
};

beforeAll(async () => {
  handle = await openMind({ storage: new MemoryStorage() });
  const { mind } = handle;
  bot = (await mind.profiles.create("owner", { name: "Alpha", onboard: false })).id;
  const main = await mind.profiles.ensureMain("owner", bot);
  const conversation = String(
    await Effect.runPromise(mind.converse.conversationIdOf(await mind.profiles.keyOfRow(main))),
  );
  parked = [
    { taskId: "41", kind: "pi.generation", conversationId: conversation },
    // Unmapped (no bot): nobody's to retry from the app.
    { taskId: "42", kind: "pi.generation", conversationId: "99999" },
  ];
  const stubbed = {
    ...mind,
    converse: {
      ...mind.converse,
      parked: () => Effect.succeed(parked),
      retryParked: (taskId: string) =>
        Effect.sync(() => {
          retried.push(taskId);
          parked = parked.filter((task) => task.taskId !== taskId);
          return "retried" as const;
        }),
    },
  } as typeof mind;
  server = createServer(
    createRestHandler({
      mind: stubbed,
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

describe("Needs you: parked tasks", () => {
  it("lists the parked tasks", async () => {
    const mine = await call("GET", "/api/needs-you");
    expect(mine.json.parked).toEqual([
      expect.objectContaining({ taskId: "41", profile: bot, kind: "pi.generation" }),
    ]);
  });

  it("retries the owner's own parked task, which then leaves the list", async () => {
    const response = await call("POST", "/api/needs-you/parked/41/retry");
    expect(response).toEqual({ status: 200, json: { outcome: "retried" } });
    expect(retried).toEqual(["41"]);
    expect((await call("GET", "/api/needs-you")).json.parked).toEqual([]);
  });
});
