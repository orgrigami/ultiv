/**
 * A routine trial on the real engine (faux model, MemoryStorage): the trial
 * turn sees the live fire's input, its tool call is held back (the tool never
 * executes), what it said and tried lands on the job (newest last, at most
 * TRIALS_KEPT), and listeners hear it.
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
import { TRIALS_KEPT, type CronJobInfo } from "@spriessen/contracts";
import { converseService } from "../converse/converse.ts";
import { replayGuard, replayGuardExtension, type ReplayGuard } from "../evals/guard.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import { readCronJobs, writeCronJobs } from "../schedules/schedules.ts";
import { TASK_BRIEF } from "../tasks/tasks.ts";
import { keptInput, trialInputOf, trialsService } from "./trial.ts";

const ctx = BACKGROUND_CONTEXT;

const profiles = {
  rowOf: async () => ({ id: "s", owner: "owner", profile: "bot-1" }),
  get: async () => ({ id: "bot-1", model: null, policies: {} }),
  adoptConversation: async () => undefined,
  agentFor: () => ({}),
} as unknown as ProfilesService;

const job: CronJobInfo = {
  id: "job-1",
  sessionId: "s",
  profile: "bot-1",
  schedule: "0 9 * * *",
  prompt: "email the team the weekly numbers",
  enabled: true,
  failures: 0,
  createdAt: 0,
  lastRunAt: null,
  lastError: null,
  trial: true,
};

const rig = async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let sent = 0;
  const registry = createRegistry();
  registry.install({
    name: "probe",
    tools: [
      defineTool({
        name: "send_email",
        description: "Sends an email.",
        parameters: Type.Object({ to: Type.String() }),
        execute: async () => {
          sent += 1;
          return { output: [{ type: "text", text: "sent" }] };
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
  await Effect.runPromise(writeCronJobs(converse, [job]));
  const trials = trialsService({ converse, profiles, guard: late.guard, knownModel: () => true });
  return { faux, harness, converse, trials, sent: () => sent };
};

describe("routine trials (faux model)", () => {
  it("holds back every action and keeps what the routine would have done", async () => {
    const r = await rig();
    const seen: string[] = [];
    const step =
      (message: ReturnType<typeof fauxAssistantMessage>): FauxResponseStep =>
      async (context) => {
        seen.push(JSON.stringify(context.messages));
        return message;
      };
    r.faux.setResponses([
      step(
        fauxAssistantMessage(fauxToolCall("send_email", { to: "team" }), { stopReason: "toolUse" }),
      ),
      step(fauxAssistantMessage(fauxText("I would have emailed the team."))),
    ]);
    let heard = 0;
    r.trials.onChange(() => (heard += 1));
    const trial = await r.trials.runCron(job);
    expect(trial.error).toBeNull();
    expect(trial.reply).toBe("I would have emailed the team.");
    expect(trial.actions).toEqual([{ name: "send_email", input: { to: "team" } }]);
    expect(r.sent()).toBe(0);
    expect(seen[0]).toContain("[cron job-1] email the team the weekly numbers");
    expect(seen[1]).toContain("[dry run]");
    expect(heard).toBe(1);
    const stored = (await readCronJobs(r.converse))[0];
    expect(stored?.trials).toHaveLength(1);
    expect(stored?.trials?.[0]?.actions[0]?.name).toBe("send_email");
    await r.harness.close(ctx);
  });

  it("keeps only the latest trials on the job", async () => {
    const r = await rig();
    r.faux.setResponses(
      Array.from({ length: TRIALS_KEPT + 1 }, (_, n) => fauxAssistantMessage(fauxText(`run ${n}`))),
    );
    for (let n = 0; n <= TRIALS_KEPT; n += 1) await r.trials.runCron(job);
    const stored = (await readCronJobs(r.converse))[0];
    expect(stored?.trials?.map((trial) => trial.reply)).toEqual(["run 1", "run 2", "run 3"]);
    await r.harness.close(ctx);
  });
});

describe("trial input and kept inputs", () => {
  it("sends the exact input the live fire would", () => {
    expect(trialInputOf({ id: "j", prompt: "check", run: "chat" })).toBe("[cron j] check");
    const task = trialInputOf({ id: "j", prompt: "check", run: "task" });
    expect(task.startsWith(TASK_BRIEF)).toBe(true);
    expect(task).toContain("[cron j] check");
    expect(task).toContain("[nothing to report]");
  });

  it("keeps a long input short and JSON-safe", () => {
    expect(keptInput({ a: 1 })).toEqual({ a: 1 });
    const long = keptInput({ text: "x".repeat(5_000) });
    expect(typeof long === "object" && long !== null && "truncated" in long).toBe(true);
    expect(keptInput(undefined)).toBeNull();
  });
});
