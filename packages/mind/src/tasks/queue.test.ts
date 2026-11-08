/**
 * The task queue against the real engine (faux model, MemoryStorage): over
 * the limit a spawn waits as "queued" and starts by itself when a slot
 * frees; a queued task cancels without ever running; a full queue refuses;
 * and the parent's wake carries the files a run wrote.
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
import { converseService } from "../converse/converse.ts";
import { tasksService } from "./tasks.ts";
import { MAX_QUEUED_TASKS } from "./limits.ts";
import { NOT_STARTED, wakeTextOf } from "./wake.ts";
import type { TaskInfo } from "@spriessen/contracts";

const ctx = BACKGROUND_CONTEXT;

/** A tasks service whose bots run one task at a time; the first reply waits for `release`. */
const rig = async (
  replies: readonly string[],
  wiring: {
    limitOf?: () => Promise<number>;
    isPaused?: () => Promise<boolean>;
    spendOf?: () => Promise<{ today: number; budget: number | null }>;
    binder?: () => Promise<{ owner: string; profileId: string } | null>;
  } = { limitOf: async () => 1 },
) => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => (started = resolve));
  const steps: FauxResponseStep[] = replies.map((text, index) => async () => {
    if (index === 0) {
      started();
      await gate;
    }
    return fauxAssistantMessage(fauxText(text));
  });
  faux.setResponses(steps);
  const model = faux.getModel();
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry: createRegistry(), settings: { steeringMode: "all" } },
    ctx,
  );
  const converse = converseService(harness, {
    model: { provider: model.provider, modelId: model.id },
  });
  const tasks = tasksService(converse);
  await tasks.attach(wiring.binder === undefined ? async () => null : wiring.binder, wiring);
  const spawn = (prompt: string) =>
    Effect.runPromise(
      tasks.spawn({ sessionId: "", owner: "agent", conversationId: "chat-1", prompt }),
    );
  const row = async (id: string) => (await Effect.runPromise(tasks.get(id))) as TaskInfo;
  const settled = async (id: string) => {
    for (let i = 0; i < 300; i += 1) {
      const current = await row(id);
      if (current.status !== "running" && current.status !== "queued") return current;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("task never settled");
  };
  return { harness, tasks, spawn, row, settled, blocked, release };
};

describe("task queue (faux model)", () => {
  it("the daily token budget refuses spawns with a sentence, and holds queued ones", async () => {
    const spend = { today: 100, budget: 5_000 as number | null };
    const r = await rig(["first", "second"], {
      limitOf: async () => 1,
      spendOf: async () => ({ today: spend.today, budget: spend.budget }),
      binder: async () => ({ owner: "agent", profileId: "p1" }),
    });
    const a = await r.spawn("a");
    await r.blocked;
    const b = await r.spawn("b");
    expect(a.status).toBe("running");
    expect(b.status).toBe("queued");
    // The budget lands mid-queue: nothing new is admitted…
    spend.today = 5_000;
    const refused = await Effect.runPromise(
      Effect.result(
        r.tasks.spawn({ sessionId: "", owner: "agent", conversationId: "chat-1", prompt: "nope" }),
      ),
    );
    expect(refused._tag).toBe("Failure");
    // …and the queued one waits for the next day, not the freed slot.
    r.release();
    expect((await r.settled(a.id)).status).toBe("done");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await r.row(b.id)).status).toBe("queued");
    await r.harness.close(ctx);
  });

  it("the global pause holds starts; resuming pumps what fits", async () => {
    let paused = true;
    const r = await rig(["first"], {
      limitOf: async () => 1,
      isPaused: async () => paused,
    });
    const a = await r.spawn("a");
    // Paused: the spawn is admitted but nothing starts — it waits as queued.
    expect(a.status).toBe("queued");
    paused = false;
    await r.tasks.refill();
    await r.blocked;
    expect((await r.row(a.id)).status).toBe("running");
    r.release();
    expect((await r.settled(a.id)).result).toBe("first");
    await r.harness.close(ctx);
  });

  it("queues over the limit and starts the next task when a slot frees", async () => {
    const r = await rig(["first", "second"]);
    const a = await r.spawn("a");
    await r.blocked;
    const b = await r.spawn("b");
    expect(a.status).toBe("running");
    expect(b.status).toBe("queued");
    expect(b.next).toContain("[task brief]");
    r.release();
    expect((await r.settled(a.id)).result).toBe("first");
    const done = await r.settled(b.id);
    expect(done).toMatchObject({ status: "done", result: "second" });
    expect(done.next).toBeUndefined();
    expect(done.startedAt).toBeGreaterThanOrEqual((await r.row(a.id)).finishedAt ?? 0);
    await r.harness.close(ctx);
  });

  it("cancels a queued task before it ever runs", async () => {
    const r = await rig(["first"]);
    const a = await r.spawn("a");
    await r.blocked;
    const b = await r.spawn("b");
    expect(await Effect.runPromise(r.tasks.cancel(b.id))).toBe(true);
    expect(await r.row(b.id)).toMatchObject({ status: "cancelled", error: NOT_STARTED });
    r.release();
    expect((await r.settled(a.id)).status).toBe("done");
    expect((await r.row(b.id)).status).toBe("cancelled");
    await r.harness.close(ctx);
  });

  it("refuses a spawn when the bot's queue is full", async () => {
    const r = await rig(["first"]);
    const a = await r.spawn("a");
    await r.blocked;
    for (let i = 0; i < MAX_QUEUED_TASKS; i += 1) await r.spawn(`q${i}`);
    const refused = await Effect.runPromise(
      Effect.result(
        r.tasks.spawn({ sessionId: "", owner: "agent", conversationId: "chat-1", prompt: "x" }),
      ),
    );
    expect(refused._tag).toBe("Failure");
    for (const task of await Effect.runPromise(r.tasks.list())) {
      if (task.status === "queued") await Effect.runPromise(r.tasks.cancel(task.id));
    }
    r.release();
    await r.settled(a.id);
    await r.harness.close(ctx);
  });
});

describe("the wake", () => {
  const done: TaskInfo = {
    id: "t1",
    sessionId: "",
    owner: "agent",
    conversationId: "chat-1",
    prompt: "p",
    status: "done",
    result: "Here it is.",
    error: null,
    createdAt: 0,
    finishedAt: 1,
  };

  it("links the files the run wrote, so the chat can hand them over", () => {
    const text = wakeTextOf(done, [
      { id: "abc", name: "report.md" },
      { id: "def", name: "data [v2].csv" },
    ]);
    expect(text).toContain("[task t1 finished]");
    expect(text).toContain("- [report.md](/api/artifacts/abc)");
    expect(text).toContain("- [data  v2 .csv](/api/artifacts/def)");
    expect(wakeTextOf(done)).not.toContain("Files");
  });

  it("says a cancelled queued task never started", () => {
    expect(wakeTextOf({ ...done, status: "cancelled", error: NOT_STARTED })).toContain(
      "before it started",
    );
  });
});
