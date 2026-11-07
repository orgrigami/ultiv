/**
 * The mind's side of background shell jobs (@spriessen/ext bash-jobs.ts):
 * each running job is recorded in the `ultiv.bash-jobs` doc, and its end
 * wakes the conversation that started it with the result, exactly once (the
 * request id), steering a turn in flight so the bot reads it at its next
 * step. A restart ends every job with the process; at boot each job still on
 * record wakes its conversation as lost, with the note to check what it
 * changed before running it again, and the record is cleared.
 */
import { defineDoc } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { jobLostText, type BashJob, type BashJobHost } from "@spriessen/ext";
import type { ConverseService } from "../converse/converse.ts";

type StoredJob = {
  id: string;
  conversationId: string;
  target: string;
  title: string;
  startedAt: number;
};

export const BashJobsDoc = defineDoc<{ jobs: StoredJob[] }>({
  kind: "ultiv.bash-jobs",
  version: 1,
  scope: "session",
  initial: () => ({ jobs: [] }),
  checkpointWhen: () => true,
});

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

const write = (converse: ConverseService, change: (jobs: StoredJob[]) => StoredJob[]) =>
  run(
    converse.docs.commit(async (tx) => {
      const draft = await tx.doc(BashJobsDoc);
      draft.jobs = change([...draft.jobs]);
    }),
  );

/** Wake a conversation with a job's outcome, once per request id; never throws. */
const wake = async (
  converse: ConverseService,
  conversationId: string,
  text: string,
  requestId: string,
): Promise<void> => {
  const conversation = await run(converse.open(conversationId));
  if (conversation === undefined) return;
  const submission = await run(converse.submit(conversation, text, "steer", requestId));
  void run(converse.settle(conversation, submission)).catch((cause: unknown) =>
    console.error("bash job wake turn failed:", cause),
  );
};

/**
 * The host the bash tool reports to. Doc writes run one at a time, so a
 * job that ends before its start was recorded is still cleared.
 */
export const bashJobHost = (converseOf: () => ConverseService | undefined): BashJobHost => {
  let chain: Promise<unknown> = Promise.resolve();
  const later = (step: (converse: ConverseService) => Promise<unknown>): void => {
    chain = chain
      .then(() => {
        const converse = converseOf();
        return converse === undefined ? undefined : step(converse);
      })
      .catch((cause: unknown) => console.error("bash job record failed:", cause));
  };
  return {
    started: (job: BashJob) =>
      later((converse) =>
        write(converse, (jobs) => [...jobs.filter((row) => row.id !== job.id), { ...job }]),
      ),
    finished: (job: BashJob, text: string) =>
      later(async (converse) => {
        await write(converse, (jobs) => jobs.filter((row) => row.id !== job.id));
        await wake(converse, job.conversationId, text, `bash-job:${job.id}`);
      }),
  };
};

/** Boot: every job still on record was cut off by the restart; say so, then clear the record. */
export const recoverBashJobs = async (converse: ConverseService): Promise<number> => {
  const lost = (await run(converse.docs.snapshot(BashJobsDoc)))?.jobs ?? [];
  if (lost.length === 0) return 0;
  await write(converse, (jobs) => jobs.filter((row) => !lost.some((gone) => gone.id === row.id)));
  for (const job of lost) {
    await wake(converse, job.conversationId, jobLostText(job), `bash-job-lost:${job.id}`).catch(
      (cause: unknown) => console.error(`bash job ${job.id} lost-wake failed:`, cause),
    );
  }
  return lost.length;
};
