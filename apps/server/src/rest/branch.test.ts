import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind, projectTranscript } from "@spriessen/mind";
import type { SessionInfo } from "@spriessen/contracts";
import type { RouteArgs } from "./types.ts";
import { branchRoutes } from "./branch.ts";
import { readView, TRANSCRIPT_WINDOW } from "@spriessen/mind";

type Mind = Awaited<ReturnType<typeof openMind>>["mind"];

const call = async (mind: Mind, owner: string, sessionId: string, body: unknown) => {
  let captured: { status: number; body: unknown } = { status: 0, body: null };
  const path = `/api/sessions/${sessionId}/branch`;
  const handled = await branchRoutes({
    mind,
    scheduler: {} as RouteArgs["scheduler"],
    req: { method: "POST" } as RouteArgs["req"],
    res: {} as RouteArgs["res"],
    url: new URL(`http://localhost${path}`),
    owner,
    path,
    json: (status, payload) => {
      captured = { status, body: payload };
    },
    readJson: async <T>() => body as T,
    readBody: async () => Buffer.from(JSON.stringify(body)),
  });
  return { handled, ...captured };
};

const setup = async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const { mind } = handle;
  const bot = await mind.profiles.create("harry", { name: "Brancher", onboard: false });
  const chat = await mind.profiles.createSession("harry", bot.id, "Trip");
  const conversation = await Effect.runPromise(
    mind.converse.ensure(await mind.profiles.keyForSession("harry", chat.id)),
  );
  await conversation.submit(
    {
      type: "write",
      entry: {
        kind: "ultiv.input",
        model: [{ role: "user", content: [{ type: "text", text: "book a train" }], timestamp: 1 }],
      },
    },
    BACKGROUND_CONTEXT,
  );
  const state = await readView(conversation, TRANSCRIPT_WINDOW);
  const [owner] = projectTranscript(state.entries ?? [], undefined, false);
  if (owner === undefined) throw new Error("no owner message");
  return { handle, mind, chat, at: owner.id };
};

describe("POST /api/sessions/:id/branch", () => {
  it("edits a message into a new chat and sends the new text there", async () => {
    const { handle, mind, chat, at } = await setup();
    const result = await call(mind, "harry", chat.id, { at, mode: "edit", text: "book a plane" });
    expect(result.status).toBe(200);
    const branch = result.body as SessionInfo;
    expect(branch.branchOf).toEqual({ sessionId: chat.id, at });
    const conversation = await Effect.runPromise(
      mind.converse.ensure(await mind.profiles.keyForSession("harry", branch.id)),
    );
    const state = await readView(conversation, TRANSCRIPT_WINDOW);
    const texts = JSON.stringify(state.entries ?? []);
    expect(texts).toContain("book a plane");
    expect(texts).not.toContain("book a train");
    await handle.close();
  });

  it("refuses bad requests and answers another owner's chat as missing", async () => {
    const { handle, mind, chat, at } = await setup();
    expect((await call(mind, "harry", chat.id, { at, mode: "edit", text: " " })).status).toBe(400);
    expect((await call(mind, "harry", chat.id, { at: "x", mode: "from" })).status).toBe(400);
    expect((await call(mind, "harry", chat.id, { at, mode: "sideways" })).status).toBe(400);
    const foreign = await call(mind, "mallory", chat.id, { at, mode: "edit", text: "hi" });
    expect(foreign.status).toBe(404);
    expect((await call(mind, "harry", chat.id, { at: 999_900, mode: "from" })).status).toBe(404);
    await handle.close();
  });
});
