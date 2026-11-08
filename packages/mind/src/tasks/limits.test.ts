import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { TaskInfo } from "@spriessen/contracts";
import { taskTools } from "../act/task-tools.ts";
import { projectRefOf } from "../projects/links.ts";
import { openMind } from "../entity.ts";
import { stepLine } from "./steps.ts";
import { TasksDoc } from "./tasks.ts";
import { taskLimitOf, workspaceTaskLimitOf } from "./limits.ts";

const running = (id: string, conversationId: string, profileId: string): TaskInfo => ({
  id,
  sessionId: "",
  owner: "agent",
  conversationId,
  prompt: `work ${id}`,
  status: "running",
  result: null,
  error: null,
  createdAt: Date.now(),
  finishedAt: null,
  bot: { owner: "harry", profileId },
});

describe("Task limits and status", () => {
  it("queues a spawn over the bot's running limit, and lists it as queued", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { converse, profiles } = handle.mind;
    const bot = await profiles.create("harry", { name: "Scout", onboard: false });
    await profiles.update("harry", bot.id, { policies: { ...bot.policies, maxRunningTasks: 2 } });
    const main = await Effect.runPromise(
      converse.ensure(await profiles.keyOfRow(await profiles.ensureMain("harry", bot.id))),
    );
    const mainId = String(main.id);
    const rows = [running("r0", mainId, bot.id), running("r1", mainId, bot.id)];
    await Effect.runPromise(
      converse.docs.commit(async (tx) => {
        (await tx.doc(TasksDoc)).tasks = [...rows, running("other", "x", "someone-else")];
      }),
    );
    const tools = taskTools(handle.mind.tasks, profiles);
    const call = (name: string, args: object) =>
      tools
        .find((tool) => tool.name === name)!
        .execute(args as never, { conversationId: main.id } as never, undefined as never);
    const queued = JSON.stringify(await call("task_spawn", { prompt: "one more" }));
    expect(queued).toContain("queued");
    const list = JSON.stringify(await call("task_list", {}));
    expect(list).toContain('"status":"queued"');
    expect(list).not.toContain("other");
    const status = JSON.stringify(await call("task_status", { id: "r0" }));
    expect(status).toContain('"steps"');
    expect(status).toContain("work r0");
    await handle.close();
  });

  it("refuses a spawn for a project that is not the bot's own open one", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { converse, profiles, projects } = handle.mind;
    const bot = await profiles.create("harry", { name: "Scout", onboard: false });
    const closed = await projects.start("harry", bot.id, { title: "Old" });
    if (!closed.ok) throw new Error(closed.error);
    await projects.change("harry", closed.project.id, { status: "done" }, "owner");
    const main = await Effect.runPromise(
      converse.ensure(await profiles.keyOfRow(await profiles.ensureMain("harry", bot.id))),
    );
    const tools = taskTools(handle.mind.tasks, profiles, { projectRef: projectRefOf(converse) });
    const spawn = tools.find((tool) => tool.name === "task_spawn")!;
    const refused = await spawn.execute(
      { prompt: "go", project: `#${closed.project.id.slice(0, 8)}` } as never,
      { conversationId: main.id } as never,
      undefined as never,
    );
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.output)).toContain("among your open projects");
    expect(await Effect.runPromise(handle.mind.tasks.list())).toEqual([]);
    await handle.close();
  });

  it("turns steps into short plain lines", () => {
    const tool = (status: "running" | "done" | "error") => ({
      id: 1,
      kind: "tool" as const,
      at: 0,
      step: { callId: "c", name: "web_search", status, input: {}, output: null, durationMs: null },
    });
    expect(stepLine(tool("running"))).toBe("Running web search…");
    expect(stepLine(tool("done"))).toBe("Used web search");
    expect(stepLine(tool("error"))).toBe("web search failed");
    expect(
      stepLine({ id: 2, kind: "output", at: 0, text: "Found  3\nflights", streaming: false }),
    ).toBe("Wrote: Found 3 flights");
    expect(stepLine({ id: 3, kind: "input", at: 0, text: "x" })).toBeUndefined();
  });

  it("takes the bot's own limit, else the stored default, else the built-in one", () => {
    expect(taskLimitOf(5, 2)).toBe(5);
    expect(taskLimitOf(null, 2)).toBe(2);
    expect(taskLimitOf(undefined, null)).toBe(workspaceTaskLimitOf(null).maxRunningTasks);
    // Out of range reads as unset.
    expect(taskLimitOf(99, 4)).toBe(4);
    expect(workspaceTaskLimitOf(7)).toEqual({ maxRunningTasks: 7, source: "db" });
  });
});
