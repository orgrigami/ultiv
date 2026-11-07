/**
 * Branching a chat on a real offline mind: an edit branch holds everything
 * BEFORE the edited message, a "from" branch everything up to the reply, the
 * source chat is never changed, a branch can branch again, and another
 * owner's chat reads as missing.
 */
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "../entity.ts";
import { INPUT_ENTRY_KIND, projectTranscript } from "../converse/steps.ts";

const OWNER = "owner";

const reply = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
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
  timestamp: Date.now(),
});

const setup = async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const { converse, profiles } = handle.mind;
  const bot = await profiles.create(OWNER, { name: "Brancher", onboard: false });
  const chat = await profiles.createSession(OWNER, bot.id, "Plans");
  const conversationOf = async (sessionId: string) =>
    Effect.runPromise(converse.ensure(await profiles.keyForSession(OWNER, sessionId)));
  /** Append one owner line and one bot reply as passive entries (no model offline). */
  const exchange = async (owner: string, bot: string) => {
    const conversation = await conversationOf(chat.id);
    for (const [kind, message] of [
      [
        INPUT_ENTRY_KIND,
        { role: "user", content: [{ type: "text", text: owner }], timestamp: Date.now() },
      ],
      ["test.reply", reply(bot)],
    ] as const) {
      await conversation.submit(
        { type: "write", entry: { kind, model: [message as never] } },
        BACKGROUND_CONTEXT,
      );
    }
  };
  const textsOf = async (sessionId: string): Promise<string[]> => {
    const conversation = await conversationOf(sessionId);
    const state = await conversation.viewState(BACKGROUND_CONTEXT);
    return projectTranscript(state.value?.entries ?? [], undefined, false).flatMap((step) =>
      step.kind === "input" || step.kind === "output" ? [step.text] : [],
    );
  };
  const idOf = async (sessionId: string, text: string): Promise<number> => {
    const conversation = await conversationOf(sessionId);
    const state = await conversation.viewState(BACKGROUND_CONTEXT);
    const step = projectTranscript(state.value?.entries ?? [], undefined, false).find(
      (candidate) =>
        (candidate.kind === "input" || candidate.kind === "output") && candidate.text === text,
    );
    if (step === undefined) throw new Error(`no step ${text}`);
    return step.id;
  };
  return { handle, profiles, chat, exchange, textsOf, idOf };
};

describe("branching a chat (offline, MemoryStorage)", () => {
  it("edit forks before the message; from forks after the reply; the source stays", async () => {
    const { handle, profiles, chat, exchange, textsOf, idOf } = await setup();
    await exchange("first question", "first answer");
    await exchange("second question", "second answer");
    const second = await idOf(chat.id, "second question");
    const firstAnswer = await idOf(chat.id, "first answer");

    const fromBranch = await profiles.branchSession(OWNER, chat.id, firstAnswer, "from");
    expect(fromBranch.branchOf).toEqual({ sessionId: chat.id, at: firstAnswer });
    expect(fromBranch.title).toBe("Plans (branch)");
    expect(await textsOf(fromBranch.id)).toEqual(["first question", "first answer"]);
    expect(await textsOf(chat.id)).toHaveLength(4);

    // A branch of the branch keeps working on the inherited history.
    const again = await profiles.branchSession(OWNER, fromBranch.id, firstAnswer, "from");
    expect(await textsOf(again.id)).toEqual(["first question", "first answer"]);

    await expect(profiles.branchSession(OWNER, chat.id, second, "from")).rejects.toMatchObject({
      _tag: "spriessen/InvalidInput",
    });
    await expect(
      profiles.branchSession("someone-else", chat.id, firstAnswer, "from"),
    ).rejects.toMatchObject({ _tag: "spriessen/NotFound" });
    await handle.close();
  });

  it("edit refuses a bot reply and forks before an owner message", async () => {
    const { handle, profiles, chat, exchange, textsOf, idOf } = await setup();
    await exchange("hello there", "hi");
    await exchange("a typo here", "noted");
    const typo = await idOf(chat.id, "a typo here");
    await expect(
      profiles.branchSession(OWNER, chat.id, await idOf(chat.id, "hi"), "edit"),
    ).rejects.toMatchObject({ _tag: "spriessen/InvalidInput" });
    const edit = await profiles.branchSession(OWNER, chat.id, typo, "edit");
    const texts = await textsOf(edit.id);
    expect(texts).toEqual(["hello there", "hi"]);
    // Editing the first message starts a fresh chat.
    const first = await idOf(chat.id, "hello there");
    const fresh = await profiles.branchSession(OWNER, chat.id, first, "edit");
    expect(await textsOf(fresh.id)).toEqual([]);
    await handle.close();
  });
});
