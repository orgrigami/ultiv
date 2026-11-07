/**
 * An eval replay on the real engine (faux model, MemoryStorage): it forks the
 * chat before the owner's message, the replay's tool call is BLOCKED (the
 * tool never executes), what the bot tried and said comes back, the guard's
 * list survives a fresh guard (a restart), and grading reads the checks and
 * Jev's answer.
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
} from "@earendil-works/pi-ai";
import type { EvalCase } from "@spriessen/contracts";
import { converseService, type ConverseService } from "../converse/converse.ts";
import type { DecideService } from "../decide/decide.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import { gradeCase } from "./grade.ts";
import { REPLAY_BLOCK, replayGuard, replayGuardExtension, type ReplayGuard } from "./guard.ts";
import { replayCase } from "./replay.ts";

const ctx = BACKGROUND_CONTEXT;

const profiles = {
  get: async () => ({ id: "bot-1", model: null, policies: {} }),
  adoptConversation: async () => undefined,
  agentFor: () => ({}),
} as unknown as ProfilesService;

const rig = async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let executed = 0;
  const registry = createRegistry();
  registry.install({
    name: "probe",
    tools: [
      defineTool({
        name: "delete_files",
        description: "Deletes files.",
        parameters: Type.Object({}),
        execute: async () => {
          executed += 1;
          return { output: [{ type: "text", text: "deleted" }] };
        },
      }),
    ],
  });
  const late: { guard?: ReplayGuard } = {};
  registry.install(
    replayGuardExtension({
      add: (id) => late.guard!.add(id),
      isReplay: (id) => late.guard!.isReplay(id),
    }),
  );
  const model = faux.getModel();
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  const converse = converseService(harness, {
    model: { provider: model.provider, modelId: model.id },
  });
  late.guard = replayGuard(converse);
  return { faux, harness, converse, guard: late.guard, executed: () => executed };
};

/** A source chat with an earlier exchange and the message under test. */
const seed = async (converse: ConverseService) => {
  const source = await Effect.runPromise(converse.ensure("source"));
  const write = async (kind: string, message: unknown) =>
    source.submit({ type: "write", entry: { kind, model: [message as never] } }, ctx);
  await write("ultiv.input", {
    role: "user",
    content: [{ type: "text", text: "hi" }],
    timestamp: 1,
  });
  const entries = await Effect.runPromise(converse.entriesOf(String(source.id), 5));
  return { source, forkAt: Number(entries[0]?.id) };
};

const caseOf = (conversationId: string, forkAt: number): EvalCase => ({
  id: "case-1",
  owner: "owner",
  profileId: "bot-1",
  title: "clean up",
  sessionId: "s",
  at: 0,
  conversationId,
  forkAt,
  input: "please clean up the old files",
  reference: { reply: "Deleted them.", tools: ["delete_files"] },
  expect: {},
  createdAt: 0,
});

const jev = (score: number) =>
  ({ available: true, yesNo: () => Effect.succeed(score) }) as unknown as DecideService;

describe("eval replay (faux model)", () => {
  it("blocks the replay's tool calls and returns what the bot tried and said", async () => {
    const { faux, harness, converse, guard, executed } = await rig();
    const { source, forkAt } = await seed(converse);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("delete_files", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("I would delete the old files.")),
    ]);
    const item = caseOf(String(source.id), forkAt);
    const outcome = await replayCase({ converse, profiles, guard }, item, "run-1", null);
    expect(outcome).toEqual({
      reply: "I would delete the old files.",
      tools: ["delete_files"],
      error: null,
    });
    expect(executed()).toBe(0);
    const fork = await Effect.runPromise(converse.ensure("eval:run-1:case-1"));
    const state = await fork.viewState(ctx);
    expect(JSON.stringify(state.value?.entries)).toContain("[eval replay]");
    expect(REPLAY_BLOCK).toContain("Tools do not run");
    // A fresh guard (a restart) still knows the replay from the doc.
    expect(await replayGuard(converse).isReplay(String(fork.id))).toBe(true);
    expect(await replayGuard(converse).isReplay(String(source.id))).toBe(false);
    await harness.close(ctx);
  });

  it("grades the checks first, then Jev's comparison", async () => {
    const item = caseOf("c", 1);
    const outcome = { reply: "I would delete them.", tools: ["delete_files"], error: null };
    const pass = await gradeCase(
      jev(0.8),
      { ...item, expect: { tools: ["delete_files"], contains: ["delete"] } },
      outcome,
    );
    expect(pass.ok).toBe(true);
    expect(pass.score).toBe(0.8);
    expect(pass.checks.map((check) => check.ok)).toEqual([true, true]);
    const forbidden = await gradeCase(
      jev(0.9),
      { ...item, expect: { notTools: ["delete_files"] } },
      outcome,
    );
    expect(forbidden.ok).toBe(false);
    expect((await gradeCase(jev(0.2), item, outcome)).ok).toBe(false);
    const noJev = await gradeCase(undefined, item, outcome);
    expect(noJev).toMatchObject({ ok: true, score: null });
    const failed = await gradeCase(jev(1), item, { reply: "", tools: [], error: "boom" });
    expect(failed).toMatchObject({ ok: false, error: "boom" });
  });
});
