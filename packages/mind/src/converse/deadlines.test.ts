/**
 * Turn deadlines (D4) against the real engine (faux model, MemoryStorage):
 * the pure step, a model that never sends a token, a reply that stalls
 * mid-turn past the turn deadline, approval waits pausing the clocks, and
 * per-bot overrides (policies → limits, bounds on the profile patch).
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
import {
  DEFAULT_FIRST_TOKEN_MS,
  DEFAULT_TURN_MS,
  deadlineStep,
  deadlinesExtension,
  limitsOf,
  noticeText,
  turnDeadlines,
  TURN_NOTICE_KIND,
  type DeadlineHit,
  type DeadlineLimits,
} from "./deadlines.ts";
import { projectTranscript } from "./steps.ts";
import { isStopped } from "./stop.ts";
import { validatePatch } from "../profiles/update.ts";
import { defaultPolicies } from "../profiles/docs.ts";

const ctx = BACKGROUND_CONTEXT;

/** A model call that never streams anything; it ends only when aborted. */
const silent: FauxResponseStep = (_context, options) =>
  new Promise((resolve) => {
    options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("late")));
  });

const rig = async (
  responses: FauxResponseStep[],
  limits: DeadlineLimits,
  tokensPerSecond = 100_000,
) => {
  const faux = fauxProvider({ tokensPerSecond });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  const model = faux.getModel();
  const registry = createRegistry();
  const hits: { id: string; hit: DeadlineHit }[] = [];
  // The engine is opened below; the watcher reaches it through this holder.
  let converse!: ReturnType<typeof converseService>;
  const deadlines = turnDeadlines({
    converse: {
      open: (id) => converse.open(id),
      liveOf: (c) => converse.liveOf(c),
      abortRun: (c) => converse.abortRun(c),
      write: (c, kind, data) => converse.write(c, kind, data),
    },
    limitsFor: () => limits,
    pollMs: 20,
    onHit: (id, hit) => hits.push({ id, hit }),
  });
  registry.install(deadlinesExtension(deadlines));
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  converse = converseService(harness, { model: { provider: model.provider, modelId: model.id } });
  const chat = await Effect.runPromise(converse.ensure("deadline-test"));
  const view = async () => (await chat.viewState(ctx)).value;
  const close = async () => {
    deadlines.stop();
    await harness.close(ctx);
  };
  return { faux, converse, chat, view, hits, deadlines, close };
};

const live = (
  run: boolean,
  generation?: Partial<NonNullable<LiveState["generation"]>>,
): LiveState =>
  ({
    ...(run ? { run: { taskId: 7, inputs: ["s1"] } } : {}),
    ...(generation ? { generation: { attempt: 1, ...generation } } : {}),
  }) as unknown as LiveState;

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 300 && !(await check()); i++) await new Promise((r) => setTimeout(r, 10));
};

/** The reason a profile patch was refused ("" when it was accepted). */
const refusal = (patch: Parameters<typeof validatePatch>[0]): string => {
  try {
    validatePatch(patch);
    return "";
  } catch (error) {
    return String((error as { reason?: unknown }).reason ?? error);
  }
};

const limits = { firstTokenMs: 1_000, turnMs: 10_000 };

describe("deadlineStep", () => {
  it("forgets an idle conversation", () => {
    expect(deadlineStep(undefined, undefined, 0, limits, false)).toEqual({ track: undefined });
    expect(deadlineStep(undefined, live(false), 0, limits, false).track).toBeUndefined();
  });

  it("hits first-token once a request has waited past the limit", () => {
    let { track, hit } = deadlineStep(undefined, live(true, {}), 0, limits, false);
    expect(hit).toBeUndefined();
    ({ track, hit } = deadlineStep(track, live(true, {}), 999, limits, false));
    expect(hit).toBeUndefined();
    ({ hit } = deadlineStep(track, live(true, {}), 1_000, limits, false));
    expect(hit).toEqual({ kind: "first-token", limitMs: 1_000 });
  });

  it("gives each retry attempt its own first-token window, and skips the backoff sleep", () => {
    let { track } = deadlineStep(undefined, live(true, { attempt: 1 }), 0, limits, false);
    const sleeping = live(true, { attempt: 1, retry: { at: 2_000, error: "x" } } as never);
    ({ track } = deadlineStep(track, sleeping, 900, limits, false));
    const { hit } = deadlineStep(track, sleeping, 1_900, limits, false);
    expect(hit).toBeUndefined();
    ({ track } = deadlineStep(track, live(true, { attempt: 2 }), 2_000, limits, false));
    expect(
      deadlineStep(track, live(true, { attempt: 2 }), 2_900, limits, false).hit,
    ).toBeUndefined();
    expect(deadlineStep(track, live(true, { attempt: 2 }), 3_000, limits, false).hit?.kind).toBe(
      "first-token",
    );
  });

  it("stops the first-token clock once anything streams, and hits the turn deadline", () => {
    const streaming = live(true, { message: { content: [] } } as never);
    let { track } = deadlineStep(undefined, streaming, 0, limits, false);
    ({ track } = deadlineStep(track, streaming, 5_000, limits, false));
    expect(deadlineStep(track, streaming, 9_999, limits, false).hit).toBeUndefined();
    expect(deadlineStep(track, streaming, 10_000, limits, false).hit).toEqual({
      kind: "turn",
      limitMs: 10_000,
    });
  });

  it("pauses both clocks while an approval waits", () => {
    let { track } = deadlineStep(undefined, live(true, {}), 0, limits, false);
    ({ track } = deadlineStep(track, live(true, {}), 500, limits, false));
    // 30 s on an approval card, polled every 10 s.
    for (let t = 10_500; t <= 30_500; t += 10_000) {
      const step = deadlineStep(track, live(true, {}), t, limits, true);
      expect(step.hit).toBeUndefined();
      track = step.track;
    }
    expect(deadlineStep(track, live(true, {}), 30_999, limits, false).hit).toBeUndefined();
    expect(deadlineStep(track, live(true, {}), 31_000, limits, false).hit?.kind).toBe(
      "first-token",
    );
  });

  it("restarts the clocks for a new run", () => {
    const { track } = deadlineStep(undefined, live(true, {}), 0, limits, false);
    const next = { run: { taskId: 8, inputs: ["s2"] }, generation: { attempt: 1 } } as never;
    expect(deadlineStep(track, next, 50_000, limits, false).hit).toBeUndefined();
  });
});

describe("per-bot limits", () => {
  it("uses the D4 defaults when a bot sets nothing (or null)", () => {
    expect(limitsOf(undefined)).toEqual({ firstTokenMs: 60_000, turnMs: 15 * 60_000 });
    expect(limitsOf({ firstTokenDeadlineSec: null, turnDeadlineMin: null })).toEqual({
      firstTokenMs: DEFAULT_FIRST_TOKEN_MS,
      turnMs: DEFAULT_TURN_MS,
    });
  });

  it("applies a bot's own override", () => {
    expect(limitsOf({ firstTokenDeadlineSec: 300, turnDeadlineMin: 60 })).toEqual({
      firstTokenMs: 300_000,
      turnMs: 3_600_000,
    });
  });

  it("the profile patch accepts whole numbers within bounds or null, nothing else", () => {
    const policies = defaultPolicies();
    expect(
      refusal({ policies: { ...policies, firstTokenDeadlineSec: 120, turnDeadlineMin: 30 } }),
    ).toBe("");
    expect(
      refusal({ policies: { ...policies, firstTokenDeadlineSec: null, turnDeadlineMin: null } }),
    ).toBe("");
    for (const bad of [
      { firstTokenDeadlineSec: 5 },
      { firstTokenDeadlineSec: 1_801 },
      { firstTokenDeadlineSec: 12.5 },
      { turnDeadlineMin: 0 },
      { turnDeadlineMin: 721 },
      { turnDeadlineMin: "10" as never },
    ]) {
      expect(refusal({ policies: { ...policies, ...bad } })).toMatch(/Deadline(Sec|Min) must be/);
    }
  });

  it("words the notice with the limit that was hit", () => {
    expect(noticeText({ kind: "first-token", limitMs: 60_000 })).toContain("nothing for 1 minute");
    expect(noticeText({ kind: "first-token", limitMs: 45_000 })).toContain("45 seconds");
    expect(noticeText({ kind: "turn", limitMs: 15 * 60_000 })).toContain("longer than 15 minutes");
  });
});

describe("turn deadlines (faux model)", () => {
  it("stops a model that never sends a token, with a clear note in the chat", async () => {
    const r = await rig([silent, fauxAssistantMessage(fauxText("second try"))], {
      firstTokenMs: 200,
      turnMs: 60_000,
    });
    const first = await Effect.runPromise(r.converse.submit(r.chat, "hello"));
    const failure = await Effect.runPromise(r.converse.settle(r.chat, first)).then(
      () => "answered",
      (e: unknown) => e,
    );
    expect(isStopped(failure)).toBe(true);
    await until(() => r.hits.length > 0);
    expect(r.hits).toEqual([{ id: String(r.chat.id), hit: { kind: "first-token", limitMs: 200 } }]);
    const entries = (await r.view())?.entries ?? [];
    expect(entries.some((e) => e.kind === TURN_NOTICE_KIND)).toBe(true);
    const steps = projectTranscript(entries, undefined, false);
    expect(steps.at(-1)).toMatchObject({ kind: "note" });
    expect(String((steps.at(-1) as { text?: string }).text)).toContain("first-reply deadline");
    // Not retried behind the owner's back: one call, and the chat is idle.
    expect(r.faux.state.callCount).toBe(1);
    expect(((await r.view())?.docs["pi.live"] as LiveState | undefined)?.run).toBeUndefined();
    // The next message works as usual.
    const again = await Effect.runPromise(r.converse.submit(r.chat, "hello again"));
    expect((await Effect.runPromise(r.converse.settle(r.chat, again))).text).toBe("second try");
    await r.close();
  });

  it("stops a turn that stalls mid-reply past the turn deadline, keeping the partial", async () => {
    // Streams ~10 tokens a second: never silent, but far too slow to finish.
    const r = await rig(
      [fauxAssistantMessage(fauxText("word ".repeat(400)))],
      { firstTokenMs: 5_000, turnMs: 400 },
      10,
    );
    const first = await Effect.runPromise(r.converse.submit(r.chat, "write an essay"));
    const failure = await Effect.runPromise(r.converse.settle(r.chat, first)).then(
      () => "answered",
      (e: unknown) => e,
    );
    expect(isStopped(failure)).toBe(true);
    await until(() => r.hits.length > 0);
    expect(r.hits.map((h) => h.hit.kind)).toEqual(["turn"]);
    const steps = projectTranscript((await r.view())?.entries ?? [], undefined, false);
    expect(steps.some((s) => s.kind === "output" && s.interrupted === true)).toBe(true);
    expect(String((steps.at(-1) as { text?: string }).text)).toContain("turn deadline");
    await r.close();
  });

  it("keeps queued messages queued after a hit (never auto-sent)", async () => {
    const r = await rig([silent, fauxAssistantMessage(fauxText("later answer"))], {
      firstTokenMs: 200,
      turnMs: 60_000,
    });
    const first = await Effect.runPromise(r.converse.submit(r.chat, "first"));
    await Effect.runPromise(r.converse.submit(r.chat, "queued", "followUp"));
    await Effect.runPromise(r.converse.settle(r.chat, first)).catch(() => undefined);
    await until(() => r.hits.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const inbox = ((await r.view())?.docs["pi.inbox"] as InboxState | undefined)?.items ?? [];
    expect(inbox.length).toBe(1);
    expect(r.faux.state.callCount).toBe(1);
    await r.close();
  });

  it("does not fire on a turn that answers in time", async () => {
    const r = await rig([fauxAssistantMessage(fauxText("quick"))], {
      firstTokenMs: 200,
      turnMs: 400,
    });
    const first = await Effect.runPromise(r.converse.submit(r.chat, "hi"));
    expect((await Effect.runPromise(r.converse.settle(r.chat, first))).text).toBe("quick");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(r.hits).toEqual([]);
    expect(r.deadlines.watching()).toEqual([]);
    await r.close();
  });
});
