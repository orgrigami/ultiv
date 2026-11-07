import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind, projectTranscript } from "@spriessen/mind";
import type { EvalCase, EvalRun } from "@spriessen/contracts";
import type { RouteArgs } from "./types.ts";
import { evalRoutes } from "./evals.ts";

type Mind = Awaited<ReturnType<typeof openMind>>["mind"];

const call = async (mind: Mind, owner: string, method: string, path: string, body?: unknown) => {
  let captured: { status: number; body: unknown } = { status: 0, body: null };
  const url = new URL(`http://localhost${path}`);
  const handled = await evalRoutes({
    mind,
    scheduler: {} as RouteArgs["scheduler"],
    req: { method } as RouteArgs["req"],
    res: {} as RouteArgs["res"],
    url,
    owner,
    path: url.pathname,
    json: (status, payload) => {
      captured = { status, body: payload };
    },
    readJson: async <T>() => (body ?? {}) as T,
    readBody: async () => Buffer.from(JSON.stringify(body ?? {})),
  });
  return { handled, ...captured };
};

const setup = async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const { mind } = handle;
  const bot = await mind.profiles.create("harry", { name: "Tester", onboard: false });
  const chat = await mind.profiles.createSession("harry", bot.id, "Inbox");
  const conversation = await Effect.runPromise(
    mind.converse.ensure(await mind.profiles.keyForSession("harry", chat.id)),
  );
  await conversation.submit(
    {
      type: "write",
      entry: {
        kind: "ultiv.input",
        model: [{ role: "user", content: [{ type: "text", text: "what's new?" }], timestamp: 1 }],
      },
    },
    BACKGROUND_CONTEXT,
  );
  const state = await conversation.viewState(BACKGROUND_CONTEXT);
  const at = projectTranscript(state.value?.entries ?? [], undefined, false)[0]?.id ?? -1;
  return { handle, mind, chat, at };
};

describe("/api/evals", () => {
  it("saves, lists, edits and runs a test for its owner only", async () => {
    const { handle, mind, chat, at } = await setup();
    const saved = await call(mind, "harry", "POST", "/api/evals", { sessionId: chat.id, at });
    expect(saved.status).toBe(200);
    const item = saved.body as EvalCase;
    expect((await call(mind, "harry", "GET", "/api/evals")).body).toHaveLength(1);
    expect((await call(mind, "mallory", "GET", "/api/evals")).body).toEqual([]);
    const patch = { expect: { contains: ["news"] } };
    expect((await call(mind, "mallory", "PATCH", `/api/evals/${item.id}`, patch)).status).toBe(404);
    const edited = await call(mind, "harry", "PATCH", `/api/evals/${item.id}`, patch);
    expect((edited.body as EvalCase).expect).toEqual({ contains: ["news"] });
    const started = await call(mind, "harry", "POST", "/api/evals/run", {});
    const run = started.body as EvalRun;
    expect(run.status).toBe("running");
    expect((await call(mind, "mallory", "GET", `/api/evals/runs/${run.id}`)).status).toBe(404);
    expect((await call(mind, "harry", "GET", `/api/evals/runs/${run.id}`)).status).toBe(200);
    expect((await call(mind, "harry", "GET", "/api/evals/runs")).body).toHaveLength(1);
    expect((await call(mind, "mallory", "DELETE", `/api/evals/${item.id}`)).status).toBe(404);
    expect((await call(mind, "harry", "DELETE", `/api/evals/${item.id}`)).status).toBe(200);
    await handle.close();
  });

  it("refuses malformed bodies and someone else's chat", async () => {
    const { handle, mind, chat, at } = await setup();
    expect((await call(mind, "harry", "POST", "/api/evals", { at })).status).toBe(400);
    const badExpect = { sessionId: chat.id, at, expect: { tools: "bash" } };
    expect((await call(mind, "harry", "POST", "/api/evals", badExpect)).status).toBe(400);
    const foreign = await call(mind, "mallory", "POST", "/api/evals", { sessionId: chat.id, at });
    expect(foreign.status).toBe(404);
    expect((await call(mind, "harry", "POST", "/api/evals/run", { caseIds: "x" })).status).toBe(
      400,
    );
    expect((await call(mind, "harry", "POST", "/api/evals/run", {})).status).toBe(400);
    expect((await call(mind, "harry", "GET", "/api/other")).handled).toBe(false);
    await handle.close();
  });
});
