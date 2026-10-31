import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { TaskInfo } from "@spreissen/contracts";
import { taskTools } from "../act/task-tools.ts";
import { openMind } from "../entity.ts";
import { stepLine } from "./steps.ts";
import { MAX_RUNNING_TASKS, TasksDoc } from "./tasks.ts";

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
  it("refuses a spawn over the per-bot running cap, naming the running ones", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { converse, profiles } = handle.mind;
    const bot = await profiles.create("harry", { name: "Scout", onboard: false });
    const main = await Effect.runPromise(
      converse.ensure(await profiles.keyOfRow(await profiles.ensureMain("harry", bot.id))),
    );
    const mainId = String(main.id);
    const rows = Array.from({ length: MAX_RUNNING_TASKS }, (_, i) =>
      running(`r${i}`, mainId, bot.id),
    );
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
    const refused = JSON.stringify(await call("task_spawn", { prompt: "one more" }));
    expect(refused).toContain(`the limit is ${MAX_RUNNING_TASKS}`);
    expect(refused).toContain("r0");
    expect(refused).not.toContain("other");
    const status = JSON.stringify(await call("task_status", { id: "r0" }));
    expect(status).toContain('"steps"');
    expect(status).toContain("work r0");
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
});
