/**
 * The react tool on a real offline mind: write/read round trip, invalid
 * emoji refusal, default-target resolution (the most recent owner message,
 * stored in the transcript id shape), replace-on-second-react, and the
 * unknown-target refusal (the kernel NotFound tag).
 */
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "../entity.ts";
import type { AuditService } from "../audit/audit.ts";
import { stepIdOf } from "../converse/steps.ts";
import { applyReaction } from "./reactions.ts";
import { ReactionsDoc, reactTools } from "./tools.ts";

const OWNER = "owner";

const setup = async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const { converse, profiles } = handle.mind;
  const bot = await profiles.create(OWNER, { name: "Acker", onboard: false });
  const session = await profiles.ensureMain(OWNER, bot.id);
  const key = await profiles.keyForSession(OWNER, session.id);
  const conversationId = String((await Effect.runPromise(converse.ensure(key))).id);
  const audit = { record: () => undefined } as unknown as AuditService;
  const [tool] = reactTools({ converse, profiles, audit });
  if (tool === undefined) throw new Error("missing react tool");
  const call = (args: object) =>
    tool.execute(
      args as never,
      { conversationId, callId: "k" } as never,
      {} as never,
    ) as unknown as Promise<{
      output: { text: string }[];
      isError?: boolean;
      details?: { entryId: number; emoji: string };
    }>;
  const say = async (text: string): Promise<number> => {
    const conversation = await Effect.runPromise(converse.ensure(key));
    await Effect.runPromise(converse.submit(conversation, text));
    const entries = (await Effect.runPromise(converse.entriesOf(conversationId, 10))) as readonly {
      id: number;
      kind: string;
    }[];
    const latest = entries.find((entry) => entry.kind === "pi.user");
    if (latest === undefined) throw new Error("no owner entry after submit");
    return stepIdOf(latest.id);
  };
  const stored = async () =>
    (await Effect.runPromise(converse.docs.snapshotKeyed(ReactionsDoc, conversationId)))
      ?.rows as never as {
      entryId: number;
      emoji: string;
      reactorProfileId: string;
    }[];
  return { handle, converse, bot, conversationId, call, say, stored };
};

describe("react tool (offline, MemoryStorage)", () => {
  it("resolves the default target, stores the row and reads it back", async () => {
    const { handle, call, say, stored } = await setup();
    const entryId = await say("ship it when ready");
    const done = await call({ emoji: "ack" });
    expect(done.isError).toBeUndefined();
    expect(done.details).toEqual({ entryId, emoji: "ack" });
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entryId).toBe(entryId);
    expect(rows[0]?.emoji).toBe("ack");
    expect(rows[0]?.reactorProfileId).not.toBe("");
    await handle.close();
  });

  it("refuses an emoji outside the fixed vocabulary and stores nothing", async () => {
    const { handle, call, say, stored } = await setup();
    await say("nice");
    const bad = await call({ emoji: "sparkles" });
    expect(bad.isError).toBe(true);
    expect(bad.output[0]?.text).toContain("unknown reaction");
    expect(await stored()).toHaveLength(0);
    await handle.close();
  });

  it("replaces the earlier reaction on a second react of the same entry", async () => {
    const { handle, call, say, stored } = await setup();
    const entryId = await say("ok ship it");
    await call({ emoji: "working" });
    await call({ emoji: "done", target: entryId });
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.emoji).toBe("done");
    expect(rows[0]?.entryId).toBe(entryId);
    await handle.close();
  });

  it("refuses an unknown target with the kernel NotFound tag", async () => {
    const { handle, call, say } = await setup();
    await say("hello");
    const refused = await call({ emoji: "ack", target: 999900 });
    expect(refused.isError).toBe(true);
    expect(refused.output[0]?.text).toContain("no message 999900");
    let tag: string | undefined;
    try {
      applyReaction([], { emoji: "ack", target: 424242 }, "bot", []);
    } catch (cause) {
      tag = (cause as { _tag?: string })._tag;
    }
    expect(tag).toBe("spriessen/NotFound");
    await handle.close();
  });
});
