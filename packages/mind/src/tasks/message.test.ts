/**
 * task_message against the real engine (faux model, MemoryStorage): a parent
 * message steers a running task at its next step, one sent while the task is
 * only writing its reply gets its own turn (whose answer becomes the result),
 * and a settled task is continued: it runs again with its earlier work in
 * context.
 */
import { describe, expect, it } from "vite-plus/test";
import { obj } from "@earendil-works/pi-schema";
import { Effect } from "effect";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { converseService } from "../converse/converse.ts";
import { tasksService } from "./tasks.ts";

const ctx = BACKGROUND_CONTEXT;

const userTexts = (context: unknown): string[] =>
  (context as { messages: readonly { role: string; content: unknown }[] }).messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content as { text?: string }[]).map((block) => block.text ?? "").join(""),
    );

/** A task whose first step blocks (in a tool, or while "writing") until released. */
const rig = async (blockIn: "tool" | "reply", extra: readonly string[] = []) => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => (started = resolve));
  const registry = createRegistry();
  const wait = defineTool({
    name: "wait",
    description: "Waits until the test releases it.",
    parameters: obj({}, { open: true }),
    execute: async () => {
      started();
      await gate;
      return { output: [{ type: "text", text: "waited" }] };
    },
  });
  registry.install({ name: "probe", tools: [wait] });
  const requests: string[][] = [];
  const step =
    (message: ReturnType<typeof fauxAssistantMessage>, hold = false): FauxResponseStep =>
    async (context) => {
      requests.push(userTexts(context));
      if (hold) {
        started();
        await gate;
      }
      return message;
    };
  faux.setResponses(
    blockIn === "tool"
      ? [
          step(fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })),
          step(fauxAssistantMessage(fauxText("done with both"))),
        ]
      : [
          step(fauxAssistantMessage(fauxText("first answer")), true),
          step(fauxAssistantMessage(fauxText("revised answer"))),
        ],
  );
  for (const text of extra) faux.appendResponses([step(fauxAssistantMessage(fauxText(text)))]);
  const model = faux.getModel();
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry, settings: { steeringMode: "all" } },
    ctx,
  );
  const converse = converseService(harness, {
    model: { provider: model.provider, modelId: model.id },
  });
  const tasks = tasksService(converse);
  await tasks.attach(async () => null);
  const task = await Effect.runPromise(
    tasks.spawn({ sessionId: "", owner: "agent", conversationId: null, prompt: "dig" }),
  );
  const settled = async () => {
    for (let i = 0; i < 200; i += 1) {
      const row = await Effect.runPromise(tasks.get(task.id));
      if (row?.status !== "running" && row?.status !== "queued") return row;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("task never settled");
  };
  return { harness, tasks, task, requests, blocked, release, settled };
};

describe("task_message (faux model)", () => {
  it("steers a running task at its next step", async () => {
    const r = await rig("tool");
    await r.blocked;
    expect(await Effect.runPromise(r.tasks.message(r.task.id, "also check prices"))).toBe("sent");
    r.release();
    const row = await r.settled();
    expect(row?.status).toBe("done");
    expect(row?.result).toBe("done with both");
    expect(r.requests).toHaveLength(2);
    expect(r.requests[0]?.[0]).toContain("[task brief]");
    expect(r.requests[1]).toContain("[from parent] also check prices");
    expect(await Effect.runPromise(r.tasks.message("nope", "more"))).toBe("unknown");
    await r.harness.close(ctx);
  });

  it("a steer from an outside turn marks the task row for good", async () => {
    const r = await rig("tool");
    await r.blocked;
    expect((await Effect.runPromise(r.tasks.get(r.task.id)))?.outside).toBeUndefined();
    expect(await Effect.runPromise(r.tasks.message(r.task.id, "clean", {}))).toBe("sent");
    expect((await Effect.runPromise(r.tasks.get(r.task.id)))?.outside).toBeUndefined();
    expect(
      await Effect.runPromise(r.tasks.message(r.task.id, "from a page", { outside: true })),
    ).toBe("sent");
    expect((await Effect.runPromise(r.tasks.get(r.task.id)))?.outside).toBe(true);
    r.release();
    const row = await r.settled();
    expect(row?.status).toBe("done");
    expect(row?.outside).toBe(true);
    await r.harness.close(ctx);
  });

  it("a message sent while the task is only writing gets its own turn and result", async () => {
    const r = await rig("reply");
    await r.blocked;
    expect(await Effect.runPromise(r.tasks.message(r.task.id, "make it shorter"))).toBe("sent");
    r.release();
    const row = await r.settled();
    expect(row?.status).toBe("done");
    expect(row?.result).toBe("revised answer");
    expect(r.requests.at(-1)).toContain("[from parent] make it shorter");
    await r.harness.close(ctx);
  });

  it("continues a settled task with its earlier work in context, waking per run", async () => {
    const r = await rig("tool", ["third answer"]);
    await r.blocked;
    r.release();
    const first = await r.settled();
    expect(first?.result).toBe("done with both");
    expect(await Effect.runPromise(r.tasks.message(r.task.id, "now in a table"))).toBe("continued");
    const running = await Effect.runPromise(r.tasks.get(r.task.id));
    expect(running).toMatchObject({ status: "running", runs: 2, result: null, finishedAt: null });
    const second = await r.settled();
    expect(second).toMatchObject({ status: "done", result: "third answer", runs: 2 });
    // The continuation's request carries the brief and the first run's work.
    const last = r.requests.at(-1) ?? [];
    expect(last[0]).toContain("[task brief]");
    expect(last.at(-1)).toBe("[from parent] now in a table");
    await r.harness.close(ctx);
  });
});
