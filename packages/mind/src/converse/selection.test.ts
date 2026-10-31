/**
 * Model selection (faux models, MemoryStorage). `model: null` means "the
 * workspace default": saving a bot on Workspace default re-applies it to every
 * chat, and those chats must keep a model (before, the engine's model was
 * cleared and every later turn failed with `no_model`).
 */
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { converseService } from "./converse.ts";

const ctx = BACKGROUND_CONTEXT;

const rig = async () => {
  const faux = fauxProvider({
    provider: "faux-test",
    tokensPerSecond: 100_000,
    models: [{ id: "default-one" }, { id: "picked-one" }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  // Every reply names the model that produced it.
  const answer: FauxResponseStep = (_context, _options, _state, model) =>
    fauxAssistantMessage(fauxText(`from ${model.id}`));
  faux.setResponses([answer, answer, answer, answer]);
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry: createRegistry() },
    ctx,
  );
  const converse = converseService(harness, {
    model: { provider: "faux-test", modelId: "default-one" },
  });
  const chat = await Effect.runPromise(converse.ensure("selection-test"));
  const reply = async (text: string) => {
    const result = await Effect.runPromise(converse.turn(chat, text));
    return JSON.stringify(result);
  };
  const agent = () => Effect.runPromise(converse.agentOf(chat));
  return { converse, chat, reply, agent };
};

describe("model selection", () => {
  it("keeps a model when a Workspace default bot is saved (model: null)", async () => {
    const r = await rig();
    // What the Edit-bot dialog's save sends for a Workspace default bot.
    await Effect.runPromise(r.converse.configure(r.chat, { model: null }));
    expect((await r.agent()).model).toBe("faux-test/default-one");
    const out = await r.reply("hello");
    expect(out).toContain("from default-one");
    expect(out).not.toContain("no_model");
  });

  it("an explicit model is applied as is, and null goes back to the default", async () => {
    const r = await rig();
    await Effect.runPromise(
      r.converse.configure(r.chat, { model: "faux-test/picked-one", effort: null }),
    );
    expect((await r.agent()).model).toBe("faux-test/picked-one");
    expect(await r.reply("hello")).toContain("from picked-one");
    await Effect.runPromise(r.converse.configure(r.chat, { model: null, effort: null }));
    expect((await r.agent()).model).toBe("faux-test/default-one");
    expect(await r.reply("again")).toContain("from default-one");
  });
});
