/**
 * Background shell jobs, the mind's side (faux model, MemoryStorage): a job
 * is on record while it runs, its end wakes the conversation with the result
 * once, and a job a restart cut off wakes it as lost, then leaves the record.
 */
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { newJob } from "@spriessen/ext";
import { converseService, type ConverseService } from "../converse/converse.ts";
import { BashJobsDoc, bashJobHost, recoverBashJobs } from "./bash-jobs.ts";

const ctx = BACKGROUND_CONTEXT;

const rig = async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxText("noted")),
    fauxAssistantMessage(fauxText("ok")),
  ]);
  const model = faux.getModel();
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry: createRegistry() },
    ctx,
  );
  const converse = converseService(harness, {
    model: { provider: model.provider, modelId: model.id },
  });
  const chat = await Effect.runPromise(converse.ensure("chat"));
  return { harness, converse, chat };
};

const recorded = async (converse: ConverseService) =>
  (await Effect.runPromise(converse.docs.snapshot(BashJobsDoc)))?.jobs ?? [];

const transcript = async (chat: { viewState: (c: typeof ctx) => Promise<{ value?: unknown }> }) =>
  JSON.stringify((await chat.viewState(ctx)).value ?? {});

const until = async (probe: () => Promise<boolean>): Promise<void> => {
  for (let n = 0; n < 100 && !(await probe()); n += 1)
    await new Promise((resolve) => setTimeout(resolve, 20));
};

describe("bash job host", () => {
  it("records a running job and wakes its conversation with the result", async () => {
    const r = await rig();
    const host = bashJobHost(() => r.converse);
    const job = newJob(String(r.chat.id), "vm", "make test");
    host.started(job);
    await until(async () => (await recorded(r.converse)).length === 1);
    expect((await recorded(r.converse))[0]?.id).toBe(job.id);
    host.finished(job, `[job ${job.id} finished] exit 0: make test\n\nall green`);
    await until(async () => (await transcript(r.chat)).includes("all green"));
    expect(await transcript(r.chat)).toContain(`[job ${job.id} finished]`);
    expect(await recorded(r.converse)).toEqual([]);
    await r.harness.close(ctx);
  });

  it("a job still on record at boot wakes its conversation as lost", async () => {
    const r = await rig();
    const job = newJob(String(r.chat.id), "vm", "npm run build");
    await Effect.runPromise(
      r.converse.docs.commit(async (tx) => {
        (await tx.doc(BashJobsDoc)).jobs = [{ ...job }];
      }),
    );
    expect(await recoverBashJobs(r.converse)).toBe(1);
    await until(async () => (await transcript(r.chat)).includes(`[job ${job.id} lost]`));
    expect(await transcript(r.chat)).toContain("Check what it changed before running it again");
    expect(await recorded(r.converse)).toEqual([]);
    expect(await recoverBashJobs(r.converse)).toBe(0);
    await r.harness.close(ctx);
  });
});
