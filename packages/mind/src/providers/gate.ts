/**
 * The Gate: a process-wide bound on concurrent model requests. N sessions
 * means N concurrent turns and scripts otherwise — the gateway answers bursts
 * with 429s.
 *
 * Contract care: `Models.stream/streamSimple` return the event stream
 * SYNCHRONOUSLY and the harness consumes it with
 * `for await (const event of events)` — wrapping the CALL in a Promise breaks
 * that (a Promise is not async-iterable; that faulted every live turn once).
 * So the slot wraps CONSUMPTION instead: `result()` and each full iteration,
 * which is exactly the lifetime of one provider request. The gated methods
 * are also shadowed onto the instance, so pi-ai's `complete/completeSimple`
 * (which call `this.stream*` internally — the harness compacts through
 * `completeSimple`) pass through the gate as well. Everything stays bound to
 * the original instance: pi-ai's class keeps private state, so receivers
 * must not change.
 */
import type { Lane, ModelLanes } from "./lanes.ts";
import type {
  AssistantMessageEventStream,
  Api,
  Context,
  Model,
  Models,
} from "@earendil-works/pi-ai";

/**
 * A promise-land counting semaphore with two lanes. The owner's chats come
 * first: a waiting owner request is admitted before any waiting background
 * one, and background work (tasks, test replays) may hold at most
 * `limit - 1` slots, so one slot is always left for the owner while a task
 * crowd runs. The total never exceeds `limit`. With a limit of 1 there is no
 * slot to keep; the owner still goes first.
 */
export class Gate {
  private activeCount = 0;
  private backgroundCount = 0;
  private readonly limit: number;
  private readonly waiters: Record<Lane, (() => void)[]> = { owner: [], background: [] };

  constructor(limit: number) {
    this.limit = limit;
  }

  get queued(): number {
    return this.waiters.owner.length + this.waiters.background.length;
  }

  get active(): number {
    return this.activeCount;
  }

  /** Background work may take a slot: under its own cap and no owner waiting. */
  private backgroundFits(): boolean {
    const cap = this.limit > 1 ? this.limit - 1 : this.limit;
    return (
      this.activeCount < this.limit && this.backgroundCount < cap && this.waiters.owner.length === 0
    );
  }

  private take(lane: Lane): void {
    this.activeCount += 1;
    if (lane === "background") this.backgroundCount += 1;
  }

  async acquire(lane: Lane = "owner"): Promise<void> {
    const fits = lane === "owner" ? this.activeCount < this.limit : this.backgroundFits();
    if (fits) {
      this.take(lane);
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiters[lane].push(() => {
        this.take(lane);
        resolve();
      });
    });
  }

  release(lane: Lane = "owner"): void {
    this.activeCount -= 1;
    if (lane === "background") this.backgroundCount -= 1;
    if (this.waiters.owner.length > 0 && this.activeCount < this.limit) {
      this.waiters.owner.shift()?.();
      return;
    }
    if (this.waiters.background.length > 0 && this.backgroundFits()) {
      this.waiters.background.shift()?.();
    }
  }

  async hold<T>(run: () => Promise<T>, lane: Lane = "owner"): Promise<T> {
    await this.acquire(lane);
    try {
      return await run();
    } finally {
      this.release(lane);
    }
  }
}

type AnyStream = (
  model: Model<Api>,
  context: Context,
  options?: unknown,
) => AssistantMessageEventStream;

type Consumable = AsyncIterable<unknown> & { readonly result: () => Promise<unknown> };

/** Bind every own + prototype function of `models` to it, then gate the streams. */
export const gateModels = (models: Models, limit: number, lanes?: ModelLanes): Models => {
  const gate = new Gate(limit);
  const bound: Record<string, unknown> = {};
  for (const source of [models, Object.getPrototypeOf(models) as object]) {
    for (const key of Object.getOwnPropertyNames(source)) {
      const value = (models as unknown as Record<string, unknown>)[key];
      if (typeof value === "function") {
        bound[key] = (value as (...args: unknown[]) => unknown).bind(models);
      } else bound[key] = value;
    }
  }
  // Forward every property to the original (bound to it: private fields);
  // the slot wraps `result` and each full iteration.
  const consume = (events: Consumable, lane: Lane): AssistantMessageEventStream =>
    new Proxy(events, {
      get(target, prop) {
        if (prop === Symbol.asyncIterator) {
          return () =>
            (async function* () {
              await gate.acquire(lane);
              try {
                yield* target;
              } finally {
                gate.release(lane);
              }
            })();
        }
        if (prop === "result") return () => gate.hold(() => target.result(), lane);
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as AssistantMessageEventStream;
  const streamOriginal = models.stream.bind(models) as AnyStream;
  const streamSimpleOriginal = models.streamSimple.bind(models) as AnyStream;
  const gated =
    (original: AnyStream): AnyStream =>
    (model, context, options) =>
      consume(
        original(model, context, options) as unknown as Consumable,
        lanes?.laneOf(options) ?? "owner",
      );
  bound.stream = gated(streamOriginal);
  bound.streamSimple = gated(streamSimpleOriginal);
  // Instance shadow: internal `this.stream*` calls (complete/completeSimple)
  // resolve through the gate too.
  const writable = models as unknown as Record<string, unknown>;
  writable.stream = bound.stream;
  writable.streamSimple = bound.streamSimple;
  return bound as unknown as Models;
};
