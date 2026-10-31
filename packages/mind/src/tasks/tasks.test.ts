import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind, type MindHandle } from "../entity.ts";
import { TasksDoc } from "./tasks.ts";

/** Polls until the predicate holds or the budget runs out (offline settles are async). */
const until = async <T>(probe: () => Promise<T>, ready: (value: T) => boolean): Promise<T> => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const value = await probe();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for the task to settle");
};

const transcriptOf = async (handle: MindHandle, conversationId: string): Promise<string> => {
  const chat = await Effect.runPromise(handle.mind.converse.open(conversationId));
  if (chat === undefined) throw new Error("parent conversation missing");
  const state = await chat.viewState(BACKGROUND_CONTEXT);
  return JSON.stringify(state.value?.entries ?? []);
};

describe("Tasks (offline, MemoryStorage)", () => {
  it("spawns, fails offline without a provider, and wakes the spawning conversation", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const parent = await Effect.runPromise(handle.mind.converse.ensure("parent"));
    const heard: string[] = [];
    handle.mind.tasks.listen((task) => heard.push(`${task.id}:${task.status}:${task.sessionId}`));
    const spawned = await Effect.runPromise(
      handle.mind.tasks.spawn({
        sessionId: "session-1",
        owner: "guest",
        conversationId: String(parent.id),
        prompt: "do the thing",
      }),
    );
    expect(spawned.status).toBe("running");
    expect(spawned.conversationId).toBe(String(parent.id));
    const settled = await until(
      () => Effect.runPromise(handle.mind.tasks.get(spawned.id)).then((task) => task ?? null),
      (task) => task !== null && task.finishedAt !== null,
    );
    // Offline there is no provider, so the turn fails loudly — the task says so.
    expect(settled?.status).toBe("failed");
    expect(settled?.error ?? "").not.toBe("");
    // A sentence for Needs you, never the bare error tag.
    expect(settled?.error).not.toMatch(/spriessen\//);
    expect(settled?.error).toMatch(/[.!?…]$/);
    // The parent is woken with the outcome as a new admitted input.
    const transcript = await until(
      () => transcriptOf(handle, String(parent.id)),
      (transcript) => transcript.includes(`[task ${spawned.id} failed]`),
    );
    expect(transcript).toContain(`[task ${spawned.id} failed]`);
    expect(heard).toEqual([`${spawned.id}:failed:session-1`]);
    await handle.close();
  });

  it("resumes still-running tasks on boot instead of reaping them", async () => {
    const storage = new MemoryStorage();
    const first = await openMind({ storage });
    const parent = await Effect.runPromise(first.mind.converse.ensure("parent"));
    // A task left "running" by a dead process (no runner attached).
    await Effect.runPromise(
      first.mind.converse.docs.commit(async (tx) => {
        const draft = await tx.doc(TasksDoc);
        draft.tasks = [
          {
            id: "stuck-task",
            sessionId: "s",
            owner: "guest",
            conversationId: String(parent.id),
            prompt: "long research",
            status: "running",
            result: null,
            error: null,
            createdAt: Date.now(),
            finishedAt: null,
          },
        ];
      }),
    );
    // A restart (same storage): the resume path re-attaches instead of reaping.
    // The first harness stays OPEN — closing it closes the shared MemoryStorage
    // itself; a real restart closes the process, not the database.
    const second = await openMind({ storage });
    const resumed = await until(
      () => Effect.runPromise(second.mind.tasks.get("stuck-task")).then((task) => task ?? null),
      (task) => task !== null && task.finishedAt !== null,
    );
    expect(resumed?.status).toBe("failed"); // offline: the resumed turn fails loudly
    expect(resumed?.error ?? "").not.toContain("interrupted by restart");
    // The continuation note lives in the TASK's conversation; the WAKE in the parent's.
    const taskChat = await Effect.runPromise(second.mind.converse.ensure("task:stuck-task"));
    const taskState = await taskChat.viewState(BACKGROUND_CONTEXT);
    expect(JSON.stringify(taskState.value?.entries)).toContain("[resume]");
    const transcript = await transcriptOf(second, String(parent.id));
    expect(transcript).toContain("[task stuck-task failed]");
    await Promise.allSettled([first.close(), second.close()]);
  });

  it("cancels a running task and wakes the parent with the cancellation", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const parent = await Effect.runPromise(handle.mind.converse.ensure("parent"));
    // A "running" row whose runner is not attached (inserted post-boot).
    await Effect.runPromise(
      handle.mind.converse.docs.commit(async (tx) => {
        const draft = await tx.doc(TasksDoc);
        draft.tasks = [
          {
            id: "stoppable",
            sessionId: "s",
            owner: "guest",
            conversationId: String(parent.id),
            prompt: "long research",
            status: "running",
            result: null,
            error: null,
            createdAt: Date.now(),
            finishedAt: null,
          },
        ];
      }),
    );
    const cancelled = await Effect.runPromise(handle.mind.tasks.cancel("stoppable"));
    expect(cancelled).toBe(true);
    expect(await Effect.runPromise(handle.mind.tasks.cancel("stoppable"))).toBe(false);
    expect(await Effect.runPromise(handle.mind.tasks.cancel("nope"))).toBe(false);
    const task = await Effect.runPromise(handle.mind.tasks.get("stoppable")).then((t) => t ?? null);
    expect(task?.status).toBe("cancelled");
    expect(task?.error).toBe("cancelled by the user");
    const transcript = await transcriptOf(handle, String(parent.id));
    expect(transcript).toContain("[task stoppable cancelled]");
    // Removal drops the row entirely; a settled task removes without a wake.
    const removal = await Effect.runPromise(handle.mind.tasks.remove("stoppable"));
    expect(removal.removed).toBe(true);
    expect(removal.cancelled).toBe(false);
    expect(await Effect.runPromise(handle.mind.tasks.get("stoppable"))).toBeUndefined();
    await handle.close();
  });

  it("a cancel wakes the parent exactly once; a quiet cancel never does", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const parent = await Effect.runPromise(handle.mind.converse.ensure("parent"));
    const row = (id: string) => ({
      id,
      sessionId: "s",
      owner: "guest",
      conversationId: String(parent.id),
      prompt: "long research",
      status: "running" as const,
      result: null,
      error: null,
      createdAt: Date.now(),
      finishedAt: null,
    });
    await Effect.runPromise(
      handle.mind.converse.docs.commit(async (tx) => {
        (await tx.doc(TasksDoc)).tasks = [row("loud"), row("quiet")];
      }),
    );
    expect(await Effect.runPromise(handle.mind.tasks.cancel("loud"))).toBe(true);
    expect(await Effect.runPromise(handle.mind.tasks.cancel("loud"))).toBe(false);
    expect(await Effect.runPromise(handle.mind.tasks.cancel("quiet", { quiet: true }))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const transcript = await transcriptOf(handle, String(parent.id));
    expect(transcript.split("[task loud cancelled]").length - 1).toBe(1);
    expect(transcript).not.toContain("[task quiet cancelled]");
    const quiet = await Effect.runPromise(handle.mind.tasks.get("quiet"));
    expect(quiet?.status).toBe("cancelled");
    expect(quiet?.notified).toBe(true);
    await handle.close();
  });
});
