/**
 * The scheduler arms exactly one timer per enabled job, however refreshes
 * overlap: two jobs firing in the same minute each refresh, and overlapping
 * refreshes used to orphan a full set of timers (every job then fired twice,
 * then four times). croner and the job registry are faked.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const live = new Set<object>();
vi.mock("croner", () => ({
  Cron: class {
    constructor() {
      live.add(this);
    }
    stop() {
      live.delete(this);
    }
  },
}));

const job = (id: string) => ({
  id,
  enabled: true,
  schedule: "0 9 * * *",
  sessionId: "s",
  profile: "p",
  failures: 0,
});
let jobs = [job("a"), job("b")];
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

vi.mock("@spriessen/mind", () => ({
  isValidSchedule: () => true,
  listCronJobs: async () => {
    await tick(5);
    return jobs;
  },
}));

// The timezone read (profile lookup) is slow, so stop() can beat it.
const mind = {
  profiles: {
    rowOf: async () => {
      await tick(10);
      return undefined;
    },
    get: async () => undefined,
  },
} as never;

afterEach(() => {
  live.clear();
  jobs = [job("a"), job("b")];
});

describe("cron scheduler", () => {
  it("overlapping refreshes leave one timer per job", async () => {
    const { startScheduler } = await import("./cron.ts");
    const scheduler = await startScheduler(mind);
    await Promise.all([scheduler.refresh(), scheduler.refresh(), scheduler.refresh()]);
    await tick(30);
    expect(live.size).toBe(2);
    scheduler.stop();
  });

  it("a refresh during a timer's timezone read does not orphan it", async () => {
    const { startScheduler } = await import("./cron.ts");
    const scheduler = await startScheduler(mind);
    // The first arm is still reading the timezone when this refresh stops it.
    await scheduler.refresh();
    await tick(30);
    expect(live.size).toBe(2);
    jobs = [job("a")];
    await scheduler.refresh();
    await tick(30);
    expect(live.size).toBe(1);
    scheduler.stop();
  });

  it("stop() leaves nothing armed, even with a refresh queued", async () => {
    const { startScheduler } = await import("./cron.ts");
    const scheduler = await startScheduler(mind);
    const pending = scheduler.refresh();
    scheduler.stop();
    await pending;
    await tick(30);
    expect(live.size).toBe(0);
  });
});
