import { describe, expect, it } from "vite-plus/test";
import type { Context, Model, Models } from "@earendil-works/pi-ai";
import { Gate, gateModels } from "./gate.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("Gate (counting semaphore)", () => {
  it("lets one through at a time and queues the rest", async () => {
    const gate = new Gate(1);
    let active = 0;
    let peak = 0;
    const work = (): Promise<number> =>
      gate.hold(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(10);
        active -= 1;
        return active;
      });
    await Promise.all([work(), work(), work()]);
    expect(peak).toBe(1);
  });

  it("admits up to the limit concurrently", async () => {
    const gate = new Gate(2);
    let active = 0;
    let peak = 0;
    const work = (): Promise<void> =>
      gate.hold(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(10);
        active -= 1;
      });
    await Promise.all([work(), work(), work(), work()]);
    expect(peak).toBe(2);
  });

  it("releases on failure so the slot is not lost", async () => {
    const gate = new Gate(1);
    await expect(
      gate.hold(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await gate.hold(async () => "ok")).toBe("ok");
  });
});

/** A stand-in for pi-ai's event stream: async-iterable plus result(). */
const fakeStream = (
  events: readonly string[],
  final: string,
  meter: { active: number; peak: number },
) => ({
  async *[Symbol.asyncIterator]() {
    for (const event of events) {
      meter.active += 1;
      meter.peak = Math.max(meter.peak, meter.active);
      await sleep(5);
      meter.active -= 1;
      yield event;
    }
  },
  async result() {
    meter.active += 1;
    meter.peak = Math.max(meter.peak, meter.active);
    await sleep(5);
    meter.active -= 1;
    return final;
  },
  extra: () => "forwarded",
});

/** pi-ai-shaped Models: stream* on the prototype, complete* delegating via `this`. */
const fakeModelsClass = (stream: () => ReturnType<typeof fakeStream>): Models => {
  const proto = {
    stream: () => stream(),
    streamSimple: () => stream(),
    completeSimple: async function (this: { streamSimple: () => ReturnType<typeof fakeStream> }) {
      return this.streamSimple().result();
    },
    getModel: () => undefined,
  };
  return Object.create(proto) as Models;
};

const model = {} as Model<"openai-completions">;
const context = { messages: [] } as Context;

describe("gateModels (stream contract)", () => {
  it("returns a synchronous async-iterable — NOT a promise (the live-fault regression)", async () => {
    const models = gateModels(
      fakeModelsClass(() => fakeStream(["a"], "final", { active: 0, peak: 0 })),
      1,
    );
    const events = models.streamSimple(model, context);
    // The harness does `for await (const event of events)` — a Promise here
    // faults with "events is not async iterable".
    const iterable = events as unknown as Record<symbol, unknown>;
    expect(typeof iterable[Symbol.asyncIterator]).toBe("function");
    const seen: unknown[] = [];
    for await (const event of events) seen.push(event);
    expect(seen).toEqual(["a"]);
    expect(await events.result()).toBe("final");
  });

  it("serializes full consumptions to the limit", async () => {
    const meter = { active: 0, peak: 0 };
    const models = gateModels(
      fakeModelsClass(() => fakeStream(["a", "b"], "final", meter)),
      1,
    );
    const run = async (): Promise<void> => {
      for await (const event of models.streamSimple(model, context)) void event;
      await models.streamSimple(model, context).result();
    };
    await Promise.all([run(), run()]);
    expect(meter.peak).toBe(1);
  });

  it("forwards methods to the original stream and gates completeSimple's internal stream", async () => {
    const meter = { active: 0, peak: 0 };
    const models = gateModels(
      fakeModelsClass(() => fakeStream([], "compacted", meter)),
      1,
    );
    expect(
      (models.streamSimple(model, context) as unknown as { extra: () => string }).extra(),
    ).toBe("forwarded");
    await expect(models.completeSimple(model, context)).resolves.toBe("compacted");
    expect(meter.peak).toBe(1);
  });
});

describe("Gate lanes (the owner first)", () => {
  it("keeps one slot for the owner while background work crowds in", async () => {
    const gate = new Gate(3);
    await gate.acquire("background");
    await gate.acquire("background");
    let third = false;
    void gate.acquire("background").then(() => {
      third = true;
    });
    await sleep(1);
    expect(third).toBe(false);
    await gate.acquire("owner");
    expect(gate.active).toBe(3);
  });

  it("admits a waiting owner request before waiting background ones", async () => {
    const gate = new Gate(1);
    await gate.acquire("owner");
    const order: string[] = [];
    void gate.acquire("background").then(() => order.push("background"));
    void gate.acquire("owner").then(() => order.push("owner"));
    gate.release("owner");
    await sleep(1);
    expect(order).toEqual(["owner"]);
    gate.release("owner");
    await sleep(1);
    expect(order).toEqual(["owner", "background"]);
  });

  it("never exceeds the limit in total", async () => {
    const gate = new Gate(2);
    let active = 0;
    let peak = 0;
    const work = (lane: "owner" | "background"): Promise<void> =>
      gate.hold(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(5);
        active -= 1;
      }, lane);
    await Promise.all([work("background"), work("owner"), work("background"), work("owner")]);
    expect(peak).toBe(2);
  });
});
