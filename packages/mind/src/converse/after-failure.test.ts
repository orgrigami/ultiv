/**
 * D3, after a failed run (faux model, MemoryStorage): messages queued behind
 * it stay queued (pi-durable's `afterFailedRun: "keep"`) and are never sent
 * by themselves; `retryQueued` (the queue's Retry chip) starts the next run
 * with them, in order.
 */
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  type InboxState,
  type LiveState,
} from "@earendil-works/pi-durable";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { converseService } from "./converse.ts";
import { projectTranscript } from "./steps.ts";

const ctx = BACKGROUND_CONTEXT;

const lastUser = (context: unknown): string => {
  const users = (context as { messages: { role: string; content: unknown }[] }).messages.filter(
    (m) => m.role === "user",
  );
  const content = users.at(-1)?.content;
  return typeof content === "string"
    ? content
    : ((content as { text?: string }[] | undefined) ?? []).map((b) => b.text ?? "").join("");
};

const rig = async () => {
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const seen: string[] = [];
  const failing: FauxResponseStep = async (context) => {
    seen.push(lastUser(context));
    await gate;
    // Not a retryable error: the run fails at once.
    return fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid request: bad" });
  };
  const answering: FauxResponseStep = (context) => {
    seen.push(lastUser(context));
    return fauxAssistantMessage(fauxText("answered the queue"));
  };
  faux.setResponses([failing, answering]);
  const model = faux.getModel();
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry: createRegistry() },
    ctx,
  );
  const converse = converseService(harness, {
    model: { provider: model.provider, modelId: model.id },
  });
  const chat = await Effect.runPromise(converse.ensure("after-failure-test"));
  const view = async () => (await chat.viewState(ctx)).value;
  const inbox = async () =>
    ((await view())?.docs["pi.inbox"] as InboxState | undefined)?.items ?? [];
  return { faux, harness, converse, chat, view, inbox, release, seen };
};

describe("after a failed run (D3)", () => {
  it("keeps queued messages queued, never auto-sent, until Retry", async () => {
    const r = await rig();
    const first = await Effect.runPromise(r.converse.submit(r.chat, "first"));
    const queued = await Effect.runPromise(r.converse.submit(r.chat, "then this", "followUp"));
    expect(await r.inbox()).toHaveLength(1);
    r.release();
    const failure = await Effect.runPromise(r.converse.settle(r.chat, first)).then(
      () => "answered",
      (e: unknown) => e,
    );
    expect(failure).not.toBe("answered");
    // Give the engine every chance to send it by itself: it must not.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await r.inbox()).toHaveLength(1);
    expect(r.faux.state.callCount).toBe(1);
    expect(((await r.view())?.docs["pi.live"] as LiveState | undefined)?.run).toBeUndefined();

    expect(await Effect.runPromise(r.converse.retryQueued(r.chat))).toBe("started");
    const answer = await Effect.runPromise(r.converse.settle(r.chat, queued));
    expect(answer.text).toBe("answered the queue");
    expect(r.seen).toEqual(["first", "then this"]);
    expect(await r.inbox()).toHaveLength(0);
    // The trigger is invisible in the chat: no extra note or bubble.
    const steps = projectTranscript((await r.view())?.entries ?? [], undefined, false);
    expect(steps.filter((s) => s.kind === "note")).toEqual([]);
    expect(await Effect.runPromise(r.converse.retryQueued(r.chat))).toBe("empty");
    await r.harness.close(ctx);
  });
});
