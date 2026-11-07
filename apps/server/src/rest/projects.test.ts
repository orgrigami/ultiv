import { describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "@spriessen/mind";
import type { ProjectInfo } from "@spriessen/contracts";
import type { RouteArgs } from "./types.ts";
import { projectRoutes } from "./projects.ts";

type Mind = Awaited<ReturnType<typeof openMind>>["mind"];

const call = async (mind: Mind, owner: string, method: string, path: string, body?: unknown) => {
  let captured: { status: number; body: unknown } = { status: 0, body: null };
  const url = new URL(`http://localhost${path}`);
  await projectRoutes({
    mind,
    scheduler: {} as RouteArgs["scheduler"],
    req: { method } as RouteArgs["req"],
    res: {} as RouteArgs["res"],
    url,
    owner,
    path: url.pathname,
    json: (status, payload) => {
      captured = { status, body: payload };
    },
    readJson: async <T>() => (body ?? {}) as T,
    readBody: async () => Buffer.from(JSON.stringify(body ?? {})),
  });
  return captured;
};

describe("/api/projects", () => {
  it("lists, steers and removes a bot's projects for their owner only", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { mind } = handle;
    const bot = await mind.profiles.create("harry", { name: "Planner", onboard: false });
    const started = await mind.projects.start("harry", bot.id, {
      title: "Move",
      milestones: ["Pack"],
    });
    if (!started.ok) throw new Error(started.error);
    const id = started.project.id;
    expect((await call(mind, "harry", "GET", `/api/projects?bot=${bot.id}`)).body).toHaveLength(1);
    expect((await call(mind, "mallory", "GET", "/api/projects")).body).toEqual([]);
    expect(
      (await call(mind, "mallory", "PATCH", `/api/projects/${id}`, { status: "done" })).status,
    ).toBe(404);
    expect(
      (await call(mind, "harry", "PATCH", `/api/projects/${id}`, { status: "later" })).status,
    ).toBe(400);
    expect((await call(mind, "harry", "PATCH", `/api/projects/${id}`, { done: [5] })).status).toBe(
      400,
    );
    const ticked = await call(mind, "harry", "PATCH", `/api/projects/${id}`, {
      done: [1],
      note: "packed",
    });
    expect((ticked.body as ProjectInfo).milestones[0]?.done).toBe(true);
    expect((ticked.body as ProjectInfo).log.at(-1)?.by).toBe("owner");
    expect((await call(mind, "mallory", "DELETE", `/api/projects/${id}`)).status).toBe(404);
    expect((await call(mind, "harry", "DELETE", `/api/projects/${id}`)).status).toBe(200);
    await handle.close();
  });

  it("lists the routines linked to each project, for their owner only", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { mind } = handle;
    const bot = await mind.profiles.create("harry", { name: "Planner", onboard: false });
    const started = await mind.projects.start("harry", bot.id, { title: "Move" });
    if (!started.ok) throw new Error(started.error);
    const main = await mind.profiles.ensureMain("harry", bot.id);
    await mind.schedules.create({
      sessionId: main.id,
      schedule: "0 9 * * 1",
      prompt: "Check the movers' quote",
      projectId: started.project.id,
    });
    await mind.schedules.create({ sessionId: main.id, schedule: "0 8 * * *", prompt: "Unlinked" });
    const rows = (await call(mind, "harry", "GET", "/api/projects")).body as {
      work: { routines: { prompt: string }[]; tasks: unknown[] };
    }[];
    expect(rows[0]?.work.routines.map((job) => job.prompt)).toEqual(["Check the movers' quote"]);
    expect(rows[0]?.work.tasks).toEqual([]);
    expect((await call(mind, "mallory", "GET", "/api/projects")).body).toEqual([]);
    await handle.close();
  });
});
