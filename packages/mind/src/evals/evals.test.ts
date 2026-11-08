/**
 * The evals faculty on a real offline mind: a chat message saves as a case
 * with its reference (the reply and tools up to the next owner message),
 * cases are per owner, a run works through its cases in the background and
 * finishes (offline every replay fails, so each result says why), and a run
 * a restart cut reads as failed. (Offline the catalog is empty, so any model
 * ref passes; the model check is the same `catalogKnows` the tasks use.)
 */
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "../entity.ts";
import { INPUT_ENTRY_KIND, projectTranscript } from "../converse/steps.ts";
import { changeEvals } from "./store.ts";
import { readView, TRANSCRIPT_WINDOW } from "../converse/view.ts";

const OWNER = "owner";

const assistant = (content: unknown[]) => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "test",
  model: "test",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 1,
});

const setup = async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const { converse, profiles, evals } = handle.mind;
  const bot = await profiles.create(OWNER, { name: "Tester", onboard: false });
  const chat = await profiles.createSession(OWNER, bot.id, "Inbox");
  const conversation = await Effect.runPromise(
    converse.ensure(await profiles.keyForSession(OWNER, chat.id)),
  );
  const write = (kind: string, message: unknown) =>
    conversation.submit(
      { type: "write", entry: { kind, model: [message as never] } },
      BACKGROUND_CONTEXT,
    );
  const user = (text: string) => ({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 1,
  });
  await write(INPUT_ENTRY_KIND, user("summarise my inbox"));
  await write("test.reply", assistant([{ type: "text", text: "You have 3 new emails." }]));
  await write(INPUT_ENTRY_KIND, user("thanks"));
  const state = await readView(conversation, TRANSCRIPT_WINDOW);
  const steps = projectTranscript(state.entries ?? [], undefined, false);
  const at = steps.find((step) => step.kind === "input")?.id ?? -1;
  return { handle, evals, chat, at, botId: bot.id };
};

const settled = async (read: () => Promise<{ status: string } | undefined>) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const row = await read();
    if (row !== undefined && row.status !== "running") return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the run never finished");
};

describe("evals (offline, MemoryStorage)", () => {
  it("saves a message as a case with what the bot did, per owner", async () => {
    const { handle, evals, chat, at, botId } = await setup();
    const item = await evals.capture(OWNER, { sessionId: chat.id, at });
    expect(item.input).toBe("summarise my inbox");
    expect(item.reference).toEqual({ reply: "You have 3 new emails.", tools: [] });
    expect(item.forkAt).toBeNull();
    expect(item.title).toBe("summarise my inbox");
    expect(await evals.list(OWNER, botId)).toHaveLength(1);
    expect(await evals.list("someone-else")).toEqual([]);
    await expect(evals.capture("someone-else", { sessionId: chat.id, at })).rejects.toMatchObject({
      _tag: "spriessen/NotFound",
    });
    const updated = await evals.update(OWNER, item.id, { expect: { contains: ["3"] } });
    expect(updated.expect).toEqual({ contains: ["3"] });
    expect(await evals.remove("someone-else", item.id)).toBe(false);
    expect(await evals.remove(OWNER, item.id)).toBe(true);
    await handle.close();
  });

  it("runs every case and finishes; refuses an empty pick", async () => {
    const { handle, evals, chat, at } = await setup();
    const item = await evals.capture(OWNER, { sessionId: chat.id, at });
    await expect(evals.start(OWNER, { botId: "other" })).rejects.toMatchObject({
      _tag: "spriessen/InvalidInput",
    });
    const started = await evals.start(OWNER, {});
    expect(started.status).toBe("running");
    expect(started.caseIds).toEqual([item.id]);
    const done = await settled(() => evals.getRun(OWNER, started.id));
    const row = await evals.getRun(OWNER, started.id);
    expect(done.status).toBe("done");
    expect(row?.results).toHaveLength(1);
    expect(row?.results[0]?.ok).toBe(false);
    expect(row?.results[0]?.error ?? "").not.toBe("");
    expect(await evals.getRun("someone-else", started.id)).toBeUndefined();
    await handle.close();
  });

  it("marks a run a restart cut as failed", async () => {
    const { handle, evals } = await setup();
    await Effect.runPromise(
      changeEvals(handle.mind.converse, () => ({
        runs: [
          {
            id: "cut",
            owner: OWNER,
            model: null,
            status: "running",
            caseIds: [],
            results: [],
            startedAt: 0,
            finishedAt: null,
            error: null,
          },
        ],
      })),
    );
    await evals.recover();
    const row = await evals.getRun(OWNER, "cut");
    expect(row).toMatchObject({ status: "failed", error: "Stopped by a restart." });
    await handle.close();
  });
});
