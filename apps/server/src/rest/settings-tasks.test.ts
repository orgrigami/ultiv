import { describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "@spriessen/mind";
import type { RouteArgs } from "./types.ts";
import { taskSettingsRoutes } from "./settings-tasks.ts";

delete process.env.SPRIESSEN_MAX_RUNNING_TASKS;

const call = async (
  mind: Awaited<ReturnType<typeof openMind>>["mind"],
  method: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> => {
  let captured = { status: 0, body: undefined as unknown };
  const args = {
    mind,
    scheduler: {} as RouteArgs["scheduler"],
    req: { method } as RouteArgs["req"],
    res: {} as RouteArgs["res"],
    url: new URL("http://localhost/api/settings/tasks"),
    owner: "harry",
    path: "/api/settings/tasks",
    json: (status: number, value: unknown) => {
      captured = { status, body: value };
    },
    readJson: async <T>() => body as T,
    readBody: async () => Buffer.from(JSON.stringify(body ?? {})),
  } as RouteArgs;
  expect(await taskSettingsRoutes(args)).toBe(true);
  return captured;
};

describe("GET/PUT /api/settings/tasks", () => {
  it("reads the built-in default, stores a new one, refuses out of range, and clears", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { mind } = handle;
    expect((await call(mind, "GET")).body).toEqual({ maxRunningTasks: 3, source: "default" });
    expect((await call(mind, "PUT", { maxRunningTasks: 5 })).body).toEqual({
      maxRunningTasks: 5,
      source: "db",
    });
    const refused = await call(mind, "PUT", { maxRunningTasks: 99 });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain(
      "Tasks at once must be a whole number from 1 to 10",
    );
    expect((await call(mind, "PUT", { maxRunningTasks: null })).body).toEqual({
      maxRunningTasks: 3,
      source: "default",
    });
    await handle.close();
  });
});
