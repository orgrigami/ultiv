/**
 * Mid-turn input against the real engine (faux model, MemoryStorage): where a
 * steered or follow-up message lands, that a turn it joins saves one reply,
 * and that withdraw and Stop keep queued messages away from the model.
 */
import { describe, expect, it } from "vite-plus/test";
import { obj } from "@earendil-works/pi-schema";
import { Effect } from "effect";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  createRegistry,
  defineTool,
  Harness,
  MemoryStorage,
  type HarnessSettings,
  type InboxState,
} from "@earendil-works/pi-durable";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { makeApprovals, type ApprovalsService } from "../approvals.ts";
import { converseService } from "./converse.ts";
import { isStopped, stopTurn } from "./stop.ts";
import { readView, TRANSCRIPT_WINDOW } from "./view.ts";

const ctx = BACKGROUND_CONTEXT;

/** The user texts a model request carried, in order. */
const userTexts = (context: unknown): string[] =>
  (context as { messages: readonly { role: string; content: unknown }[] }).messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content as { text?: string }[]).map((block) => block.text ?? "").join(""),
    );

/**
 * A conversation whose first reply calls `wait`, which blocks until released —
 * or, with `approvals`, until its approval card is decided.
 */
const steerRig = async (
  settings: HarnessSettings = { steeringMode: "all" },
  approvals?: ApprovalsService,
) => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const toolStarted = new Promise<void>((resolve) => (started = resolve));
  const registry = createRegistry();
  registry.install({
    name: "probe",
    tools: [
      defineTool({
        name: "wait",
        description: "Waits until the test releases it.",
        parameters: obj({}, { open: true }),
        execute: async () => {
          if (approvals !== undefined) {
            const request = { callId: "c1", name: "wait", input: {} };
            const decision = Effect.runPromise(approvals.request(chatId, "c1", request));
            started();
            const approved = await decision;
            return { output: [{ type: "text", text: approved ? "approved" : "denied" }] };
          }
          started();
          await gate;
          return { output: [{ type: "text", text: "waited" }] };
        },
      }),
    ],
  });
  let chatId = "";
  const requests: string[][] = [];
  const reply =
    (message: ReturnType<typeof fauxAssistantMessage>): FauxResponseStep =>
    (context) => {
      requests.push(userTexts(context));
      return message;
    };
  faux.setResponses([
    reply(fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })),
    reply(fauxAssistantMessage(fauxText("done"))),
    reply(fauxAssistantMessage(fauxText("again"))),
  ]);
  const model = faux.getModel();
  const harness = await Harness.open(new MemoryStorage(), { models, registry, settings }, ctx);
  const converse = converseService(harness, {
    model: { provider: model.provider, modelId: model.id },
  });
  const chat = await Effect.runPromise(converse.ensure("steer-test"));
  chatId = String(chat.id);
  const inbox = async (): Promise<InboxState["items"]> =>
    ((await readView(chat, TRANSCRIPT_WINDOW))?.docs["pi.inbox"] as InboxState | undefined)
      ?.items ?? [];
  const assistantReplies = async (): Promise<number> =>
    (await Effect.runPromise(converse.entriesOf(String(chat.id), 200))).filter((entry) =>
      AssistantEntry.is(entry),
    ).length;
  return { harness, converse, chat, requests, toolStarted, release, assistantReplies, inbox };
};

describe("Mid-turn input (faux model)", () => {
  it("a steer lands before the next model call and the turn saves one reply", async () => {
    const rig = await steerRig({});
    const { converse, chat } = rig;
    const first = await Effect.runPromise(converse.submit(chat, "first"));
    await rig.toolStarted;
    const second = await Effect.runPromise(converse.submit(chat, "second", "steer"));
    rig.release();
    // Both submissions settle with the same answer; settling each must not
    // append the answer twice (settle reads the stored entry, never writes one).
    const [a, b] = await Promise.all([
      Effect.runPromise(converse.settle(chat, first)),
      Effect.runPromise(converse.settle(chat, second)),
    ]);
    expect(a.text).toBe("done");
    expect(b.text).toBe("done");
    expect(rig.requests).toEqual([["first"], ["first", "second"]]);
    // One tool-call reply plus one final answer — no duplicate.
    expect(await rig.assistantReplies()).toBe(2);
    await rig.harness.close(ctx);
  });

  it("a follow-up waits for the turn to finish, then starts its own", async () => {
    const rig = await steerRig();
    const { converse, chat } = rig;
    const first = await Effect.runPromise(converse.submit(chat, "first"));
    await rig.toolStarted;
    const later = await Effect.runPromise(converse.submit(chat, "later", "followUp"));
    rig.release();
    const a = await Effect.runPromise(converse.settle(chat, first));
    const b = await Effect.runPromise(converse.settle(chat, later));
    expect(a.text).toBe("done");
    expect(b.text).toBe("again");
    // The step after the tool did not see it; the next run did.
    expect(rig.requests).toEqual([["first"], ["first"], ["first", "later"]]);
    await rig.harness.close(ctx);
  });

  it("every steer queued during a step lands together (steeringMode all)", async () => {
    const rig = await steerRig();
    const { converse, chat } = rig;
    const first = await Effect.runPromise(converse.submit(chat, "first"));
    await rig.toolStarted;
    const two = await Effect.runPromise(converse.submit(chat, "two", "steer"));
    const three = await Effect.runPromise(converse.submit(chat, "three", "steer"));
    rig.release();
    await Promise.all(
      [first, two, three].map((sub) => Effect.runPromise(converse.settle(chat, sub))),
    );
    expect(rig.requests).toEqual([["first"], ["first", "two", "three"]]);
    expect(await rig.assistantReplies()).toBe(2);
    await rig.harness.close(ctx);
  });

  it("a withdrawn steer leaves the queue and never reaches the model", async () => {
    const rig = await steerRig();
    const { converse, chat } = rig;
    const first = await Effect.runPromise(converse.submit(chat, "first"));
    await rig.toolStarted;
    const oops = await Effect.runPromise(converse.submit(chat, "oops", "steer"));
    expect((await rig.inbox()).map((item) => item.mode)).toEqual(["steer"]);
    expect(await Effect.runPromise(converse.withdraw(chat, String(oops.id)))).toBe("aborted");
    expect(await rig.inbox()).toEqual([]);
    // Withdrawing again finds nothing to take back; its settle reads as a stop, not a fault.
    const again = await Effect.runPromise(converse.withdraw(chat, String(oops.id)));
    expect(["settled", "not_found"]).toContain(again);
    const failure = await Effect.runPromise(converse.settle(chat, oops)).then(
      () => "ok",
      (e) => e,
    );
    expect(isStopped(failure)).toBe(true);
    rig.release();
    expect((await Effect.runPromise(converse.settle(chat, first))).text).toBe("done");
    expect(rig.requests).toEqual([["first"], ["first"]]);
    await rig.harness.close(ctx);
  });

  it("withdrawing a steer the turn already took reports already_placed or settled", async () => {
    const rig = await steerRig();
    const { converse, chat } = rig;
    const first = await Effect.runPromise(converse.submit(chat, "first"));
    await rig.toolStarted;
    const second = await Effect.runPromise(converse.submit(chat, "second", "steer"));
    rig.release();
    await Effect.runPromise(converse.settle(chat, first));
    const status = await Effect.runPromise(converse.withdraw(chat, String(second.id)));
    // Placed and answered: nothing to take back (the engine may have dropped the record).
    expect(["already_placed", "settled", "not_found"]).toContain(status);
    expect((await Effect.runPromise(converse.settle(chat, second))).text).toBe("done");
    await rig.harness.close(ctx);
  });

  it("Stop clears the queue and denies the waiting approval", async () => {
    const approvals = makeApprovals();
    const rig = await steerRig(undefined, approvals);
    const { converse, chat } = rig;
    const first = await Effect.runPromise(converse.submit(chat, "first"));
    await rig.toolStarted;
    expect(approvals.pendingFor(String(chat.id))).toHaveLength(1);
    const queued = await Effect.runPromise(converse.submit(chat, "queued", "steer"));
    await stopTurn(converse, approvals, chat);
    expect(approvals.pendingFor(String(chat.id))).toEqual([]);
    expect(await rig.inbox()).toEqual([]);
    for (const sub of [first, queued]) {
      const failure = await Effect.runPromise(converse.settle(chat, sub)).then(
        () => "ok",
        (e) => e,
      );
      expect(isStopped(failure)).toBe(true);
    }
    // The queued message never reached a model call.
    expect(rig.requests).toEqual([["first"]]);
    expect(isStopped(new Error("model timeout"))).toBe(false);
    await rig.harness.close(ctx);
  });
});
