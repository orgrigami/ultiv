import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { taskTools } from "../act/task-tools.ts";
import { projectTranscript } from "../converse/steps.ts";
import { openMind } from "../entity.ts";
import { TASK_UPDATE_KIND, TasksDoc, taskConversationKey } from "./tasks.ts";
import { readView } from "../converse/view.ts";

describe("notify_owner", () => {
  it("posts a passive update into the parent chat, rate-limited, without waking it", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { converse, profiles } = handle.mind;
    const bot = await profiles.create("harry", { name: "Scout", onboard: false });
    const main = await Effect.runPromise(
      converse.ensure(await profiles.keyOfRow(await profiles.ensureMain("harry", bot.id))),
    );
    const taskChat = await Effect.runPromise(converse.ensure(taskConversationKey("t1")));
    await Effect.runPromise(
      converse.docs.commit(async (tx) => {
        (await tx.doc(TasksDoc)).tasks = [
          {
            id: "t1",
            sessionId: "",
            owner: "agent",
            conversationId: String(main.id),
            prompt: "dig",
            status: "running",
            result: null,
            error: null,
            createdAt: Date.now(),
            finishedAt: null,
          },
        ];
      }),
    );
    const notify = taskTools(handle.mind.tasks, profiles).find((t) => t.name === "notify_owner")!;
    const call = (cid: unknown, text: string) =>
      notify.execute({ text } as never, { conversationId: cid } as never, undefined as never);
    const long = `Found 3 options so far. ${"x".repeat(400)}`;
    expect(JSON.stringify(await call(taskChat.id, long))).toContain("posted to your owner");
    expect(JSON.stringify(await call(taskChat.id, "again"))).toContain("one update per 2 minutes");
    expect(JSON.stringify(await call(main.id, "hi"))).toContain("only inside a background task");

    const view = await readView(main);
    const entries = view?.entries ?? [];
    // Only the passive entry: no input was admitted, so no turn was woken.
    expect(entries.map((entry) => entry.kind)).toEqual([TASK_UPDATE_KIND]);
    const steps = projectTranscript(entries, undefined, false);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.kind).toBe("note");
    const text = steps[0]?.kind === "note" ? steps[0].text : "";
    expect(text.startsWith("[task t1 update] Found 3 options so far.")).toBe(true);
    expect(text.length).toBeLessThanOrEqual("[task t1 update] ".length + 280);
    const row = await Effect.runPromise(handle.mind.tasks.get("t1"));
    expect(row?.updates).toHaveLength(1);
    await handle.close();
  });
});
