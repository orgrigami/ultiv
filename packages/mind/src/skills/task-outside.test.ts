/**
 * Phase 1b slice 2: a task inherits the outside mark of the turn that
 * spawned (or steered) it, for the whole task. The mark is on the task row.
 * Real engine (faux model, MemoryStorage): the task's one step calls
 * skill_learn; a webhook-spawned task is refused, an owner-spawned one saves.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vite-plus/test";
import { Effect } from "effect";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { converseService, type ConverseService } from "../converse/converse.ts";
import { tasksService, type TasksService } from "../tasks/tasks.ts";
import { taskTools } from "../act/task-tools.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import { makeApprovals } from "../approvals.ts";
import { learnTool, skillWriteGuard, turnContext, turnIsOutside } from "./learn.ts";
import { skillsService } from "./service.ts";
import { skillTools } from "./tools.ts";

const ctx = BACKGROUND_CONTEXT;
let root: string | undefined;
afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const LESSON = {
  name: "invoice-filing",
  lesson: "file invoices by supplier",
  body: "---\nname: invoice-filing\ndescription: Filing invoices\n---\n\nFile by supplier and year.",
};

/** Every conversation is owner-a's bot-1 here; owner-b's bot-2 owns nothing. */
const profiles = {
  scopeOf: () => ({ owner: "owner-a", profileId: "bot-1" }),
  profileOf: () => ({ id: "bot-1", policies: {} }),
} as unknown as ProfilesService;

const rig = async () => {
  root = mkdtempSync(join(tmpdir(), "spriessen-task-outside-"));
  const skills = skillsService({ root });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const late: { converse?: ConverseService; tasks?: TasksService } = {};
  const deps = {
    profiles,
    get converse() {
      return late.converse!;
    },
    get tasks() {
      return late.tasks!;
    },
  };
  const registry = createRegistry();
  // Getters: the engine exists only after the registry, so read it late.
  registry.install({
    name: "learn",
    tools: [learnTool(Object.assign(deps, { skills })) as never],
  });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("skill_learn", LESSON), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("done")),
  ]);
  const model = faux.getModel();
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  const converse = converseService(harness, {
    model: { provider: model.provider, modelId: model.id },
  });
  const tasks = tasksService(converse);
  late.converse = converse;
  late.tasks = tasks;
  await tasks.attach(async () => null);
  const run = async (outside: boolean) => {
    const task = await Effect.runPromise(
      tasks.spawn({
        sessionId: "",
        owner: "agent",
        conversationId: null,
        prompt: "file the invoices",
        ...(outside ? { outside: true } : {}),
      }),
    );
    for (let i = 0; i < 200; i += 1) {
      const row = await Effect.runPromise(tasks.get(task.id));
      if (row?.status !== "running") return row;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("task never settled");
  };
  return { harness, skills, tasks, run };
};

describe("a task inherits the outside mark", () => {
  it("an outside-spawned task can't learn on its own; an owner-spawned one can", async () => {
    const outside = await rig();
    const row = await outside.run(true);
    expect(row?.outside).toBe(true);
    expect(await outside.skills.read("owner-a", "bot-1", "invoice-filing")).toBeUndefined();
    await outside.harness.close(ctx);

    const owner = await rig();
    const clean = await owner.run(false);
    expect(clean?.outside).toBeUndefined();
    expect(await owner.skills.read("owner-a", "bot-1", "invoice-filing")).toBeDefined();
    expect(await owner.skills.read("owner-b", "bot-2", "invoice-filing")).toBeUndefined();
    await owner.harness.close(ctx);
  });

  it("task_spawn stores the spawning turn's mark; task_message makes it stick", async () => {
    const spawned: unknown[] = [];
    const steered: unknown[] = [];
    const running = {
      id: "t1",
      status: "running",
      conversationId: "c1",
      owner: "agent",
      bot: { owner: "owner-a", profileId: "bot-1" },
    };
    const tasks = {
      isTaskConversation: () => Effect.succeed(false),
      list: () => Effect.succeed([running]),
      spawn: (input: unknown) => {
        spawned.push(input);
        return Effect.succeed({ id: "t2", status: "running" });
      },
      message: (_id: string, _text: string, options?: unknown) => {
        steered.push(options);
        return Effect.succeed("sent");
      },
    } as unknown as TasksService;
    const marks: Record<string, boolean> = { "c-owner": false, "c-webhook": true };
    const tools = taskTools(tasks, profiles, {
      outsideTurn: async (id) => marks[id] ?? true,
    });
    const tool = (name: string) => tools.find((t) => t.name === name)!;
    for (const conversationId of ["c-owner", "c-webhook"]) {
      await tool("task_spawn").execute(
        { prompt: "dig" } as never,
        { conversationId } as never,
        ctx as never,
      );
      await tool("task_message").execute(
        { id: "t1", text: "more" } as never,
        { conversationId } as never,
        ctx as never,
      );
    }
    expect(spawned).toMatchObject([{ prompt: "dig" }, { prompt: "dig", outside: true }]);
    expect((spawned[0] as { outside?: boolean }).outside).toBeUndefined();
    expect(steered).toEqual([undefined, { outside: true }]);
  });

  it("turnIsOutside: owner and routine turns are clean unless they read outside content", () => {
    const base = {
      ownerInput: "",
      inputAt: 0,
      outside: [],
      vault: [],
      outsideCalls: 0,
      learned: 0,
    };
    expect(turnIsOutside({ ...base, origin: "owner" })).toBe(false);
    expect(turnIsOutside({ ...base, origin: "cron" })).toBe(false);
    expect(turnIsOutside({ ...base, origin: "webhook" })).toBe(true);
    expect(turnIsOutside({ ...base, origin: "task" })).toBe(true);
    expect(turnIsOutside({ ...base, origin: "owner", outsideCalls: 1 })).toBe(true);
    expect(turnIsOutside({ ...base, origin: "owner", outside: ["page"] })).toBe(true);
    expect(turnIsOutside({ ...base, origin: "cron", outsideTask: true })).toBe(true);
  });

  it("turnContext reads the mark from the task row, and fails closed", async () => {
    const converse = {
      entriesOf: () =>
        Effect.succeed([{ model: [{ role: "user", content: "[task brief] go", timestamp: 1 }] }]),
    } as unknown as ConverseService;
    const of = (taskOf: TasksService["taskOf"]) =>
      turnContext({ converse, tasks: { taskOf } }, "c1").then((t) => t.outsideTask);
    expect(await of(() => Effect.succeed({ outside: true } as never))).toBe(true);
    expect(await of(() => Effect.succeed({} as never))).toBe(false);
    expect(await of(() => Effect.succeed(undefined))).toBe(false);
    expect(await of(() => Effect.fail(new Error("boom")) as never)).toBe(true);
    // And skill_write in that task asks the owner first.
    root = mkdtempSync(join(tmpdir(), "spriessen-task-outside-"));
    const approvals = makeApprovals();
    const guard = skillWriteGuard({
      profiles,
      converse,
      approvals,
      tasks: { taskOf: () => Effect.succeed({ outside: true } as never) },
    });
    const write = skillTools(skillsService({ root }), profiles, { writeGuard: guard }).find(
      (t) => t.name === "skill_write",
    )!;
    const pending = write.execute(
      { name: "invoice-filing", body: LESSON.body } as never,
      { conversationId: "c1", callId: "k1" } as never,
      ctx as never,
    );
    for (let i = 0; i < 100 && approvals.pendingFor("c1").length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(approvals.pendingFor("c1")[0]?.description).toContain("outside content");
    approvals.decide("c1", "k1", false);
    expect(((await pending) as { isError?: boolean }).isError).toBe(true);
  });
});
