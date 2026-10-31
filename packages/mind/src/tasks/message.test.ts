/**
 * task_message against the real engine (faux model, MemoryStorage): a parent
 * message steers a running task at its next step, one sent while the task is
 * only writing its reply gets its own turn (whose answer becomes the result),
 * and a settled task refuses messages.
 */
import { describe, expect, it } from "vite-plus/test";
import { Type } from "typebox";
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
const rig = async (blockIn: "tool" | "reply") => {
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
    parameters: Type.Object({}),
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
      if (row?.status !== "running") return row;
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
    // A settled task refuses new instructions.
    expect(await Effect.runPromise(r.tasks.message(r.task.id, "more"))).toBe("not_running");
    expect(await Effect.runPromise(r.tasks.message("nope", "more"))).toBe("not_running");
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
});
