import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { TaskInfo } from "@spreissen/contracts";
import { runningTasksText, tasksVisibleTo } from "../act/task-live.ts";
import { openMind, type MindHandle } from "../entity.ts";
import { TasksDoc, taskConversationKey } from "./tasks.ts";

const until = async <T>(probe: () => Promise<T>, ready: (value: T) => boolean): Promise<T> => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const value = await probe();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out");
};

const row = (id: string, conversationId: string, extra: Partial<TaskInfo> = {}): TaskInfo => ({
  id,
  sessionId: "",
  owner: "agent",
  conversationId,
  prompt: "dig",
  status: "running",
  result: null,
  error: null,
  createdAt: Date.now(),
  finishedAt: null,
  ...extra,
});

const botWithMain = async (handle: MindHandle) => {
  const { converse, profiles } = handle.mind;
  const bot = await profiles.create("harry", {
    name: "Scout",
    onboard: false,
    model: { id: "deepseek-v4-1-flash", effort: "" },
  });
  const main = await Effect.runPromise(
    converse.ensure(await profiles.keyOfRow(await profiles.ensureMain("harry", bot.id))),
  );
  return { bot, mainId: String(main.id) };
};

const taskCid = async (handle: MindHandle, id: string): Promise<string> =>
  String(await Effect.runPromise(handle.mind.converse.conversationIdOf(taskConversationKey(id))));

describe("Tasks run as their bot", () => {
  it("spawn binds the task to the spawner's bot, model included, before it runs", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { bot, mainId } = await botWithMain(handle);
    const task = await Effect.runPromise(
      handle.mind.tasks.spawn({
        sessionId: "",
        owner: "agent",
        conversationId: mainId,
        prompt: "research",
        title: "  A very long title that goes well past the forty char cap  ",
      }),
    );
    expect(task.bot).toEqual({ owner: "harry", profileId: bot.id });
    expect(task.title?.length).toBeLessThanOrEqual(40);
    const cid = await taskCid(handle, task.id);
    expect(handle.mind.profiles.scopeOf(cid)?.kind).toBe("task");
    expect(handle.mind.profiles.profileOf(cid)?.id).toBe(bot.id);
    const chat = await Effect.runPromise(handle.mind.converse.ensure(taskConversationKey(task.id)));
    // A bare (legacy) id reads back provider-qualified.
    expect((await Effect.runPromise(handle.mind.converse.agentOf(chat))).model).toBe(
      "kenari/deepseek-v4-1-flash",
    );
    await handle.close();
  });

  it("a restart rebinds tasks from the parent chat or the row (memory, approvals follow)", async () => {
    const storage = new MemoryStorage();
    const first = await openMind({ storage });
    const { bot, mainId } = await botWithMain(first);
    // A legacy running row (no bot) and a finished row that carries its bot.
    for (const id of ["legacy", "finished"]) {
      await Effect.runPromise(first.mind.converse.ensure(taskConversationKey(id)));
    }
    await Effect.runPromise(
      first.mind.converse.docs.commit(async (tx) => {
        const draft = await tx.doc(TasksDoc);
        draft.tasks = [
          row("legacy", mainId),
          row("finished", "elsewhere", {
            status: "done",
            result: "ok",
            finishedAt: Date.now(),
            bot: { owner: "harry", profileId: bot.id },
          }),
        ];
      }),
    );
    const second = await openMind({ storage });
    const resumed = await until(
      () => Effect.runPromise(second.mind.tasks.get("legacy")),
      (task) => task?.bot !== undefined,
    );
    expect(resumed?.bot).toEqual({ owner: "harry", profileId: bot.id });
    for (const id of ["legacy", "finished"]) {
      const cid = await taskCid(second, id);
      const profile = await until(
        async () => second.mind.profiles.profileOf(cid),
        (found) => found !== undefined,
      );
      expect(profile?.id).toBe(bot.id);
      expect(second.mind.profiles.scopeOf(cid)?.kind).toBe("task");
    }
    await Promise.allSettled([first.close(), second.close()]);
  });

  it("task_list shows only the calling bot's tasks", () => {
    const profiles = {
      scopeOf: (cid: string) =>
        cid === "main-a"
          ? { owner: "harry", profileId: "a", kind: "main" as const, participants: null }
          : undefined,
    } as never;
    const list = [
      row("mine", "main-a", { bot: { owner: "harry", profileId: "a" } }),
      row("from-dm", "dm-a", { bot: { owner: "harry", profileId: "a" } }),
      row("theirs", "main-b", { bot: { owner: "harry", profileId: "b" } }),
      row("legacy", "main-a"),
    ];
    expect(tasksVisibleTo(profiles, "main-a", list).map((task) => task.id)).toEqual([
      "mine",
      "from-dm",
      "legacy",
    ]);
    expect(tasksVisibleTo(profiles, "unscoped", list)).toEqual([]);
  });

  it("the running-tasks prompt line names id, title and a stable start time", () => {
    const at = Date.UTC(2026, 9, 28, 7, 5);
    const text = runningTasksText(
      [row("t1", "main-a", { title: "Flight prices", createdAt: at })],
      "Asia/Jakarta",
    );
    expect(text).toContain('- t1 "Flight prices" (started 14:05)');
    expect(text).toContain("task_message");
    expect(runningTasksText([], "Asia/Jakarta")).toBeUndefined();
  });
});
