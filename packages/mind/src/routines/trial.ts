/**
 * Routine trials: a schedule's prompt run AS its bot, on the model and with
 * the input the live fire would use, in a fresh conversation the dry-run
 * guard holds (evals/guard.ts): every tool call is blocked before it runs,
 * so nothing is written, sent, spent or put up for approval. The owner reads
 * what the routine WOULD have done (its reply and each call it tried) before
 * letting it act. A routine in trial mode (`CronJobInfo.trial`) runs every
 * fire this way; "Try now" runs one on demand. Trial conversations are
 * adopted under the bot as kind "task" (background lane at the model gate,
 * listed in no chat) and stay in storage under `trial:<routine>:<run>`.
 */
import { randomUUID } from "node:crypto";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { ownerErrorText } from "@spriessen/core";
import {
  TRIALS_KEPT,
  type CronJobInfo,
  type Json,
  type RoutineTrial,
  type TrialAction,
} from "@spriessen/contracts";
import type { ConverseService } from "../converse/converse.ts";
import { projectTranscript } from "../converse/steps.ts";
import type { ReplayGuard } from "../evals/guard.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import { QUIET_ROUTINE } from "../tasks/background.ts";
import { backgroundModelFor, type TaskModel } from "../tasks/model.ts";
import { TASK_BRIEF } from "../tasks/tasks.ts";
import { readCronJobs, writeCronJobs } from "../schedules/schedules.ts";

export type TrialDeps = {
  readonly converse: ConverseService;
  readonly profiles: ProfilesService;
  readonly guard: Pick<ReplayGuard, "add">;
  readonly knownModel: (ref: string) => boolean;
};

export interface TrialsService {
  /** Run one trial of a schedule and keep it on the job (newest last). */
  readonly runCron: (job: CronJobInfo) => Promise<RoutineTrial>;
  /** Hear a trial land on a job. Returns the unsubscribe. */
  readonly onChange: (fn: () => void) => () => void;
}

/** A trial's reply and each kept input stay small: they live on the job row. */
const REPLY_CHARS = 4_000;
const INPUT_CHARS = 1_500;
const MAX_ACTIONS = 20;
/** Entries one trial turn can span. */
const SCAN = 500;

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

export const trialKey = (routineId: string, runId: string): string => `trial:${routineId}:${runId}`;

/** The exact input the live fire would send (cron.ts, tasks/background.ts). */
export const trialInputOf = (job: Pick<CronJobInfo, "id" | "prompt" | "run">): string => {
  const fire = `[cron ${job.id}] ${job.prompt}`;
  return job.run === "task" ? `${TASK_BRIEF}\n\n${fire}\n\n${QUIET_ROUTINE}` : fire;
};

/** A tool input kept JSON-safe and short. */
export const keptInput = (input: unknown): Json => {
  try {
    const text = JSON.stringify(input ?? null) ?? "null";
    if (text.length <= INPUT_CHARS) return JSON.parse(text) as Json;
    return { truncated: `${text.slice(0, INPUT_CHARS)}…` };
  } catch {
    return null;
  }
};

/** The model the live fire runs on: the bot's chat model, or its background model for task runs. */
const modelOf = (
  deps: TrialDeps,
  job: CronJobInfo,
  profile: Parameters<ProfilesService["agentFor"]>[0],
): TaskModel | null => {
  if (job.run === "task") {
    const choice = backgroundModelFor(profile, {}, deps.knownModel);
    if (choice.ok && choice.model !== undefined) return choice.model;
  }
  return profile.model !== undefined && profile.model !== null
    ? { id: profile.model.id, effort: profile.model.effort ?? "" }
    : null;
};

/** Run the trial turn and read back what the bot said and tried. */
const trialTurn = async (
  deps: TrialDeps,
  job: CronJobInfo,
  owner: string,
): Promise<Omit<RoutineTrial, "at">> => {
  const profile = await deps.profiles.get(owner, job.profile);
  if (profile === undefined) return { reply: "", actions: [], error: "This bot no longer exists." };
  const key = trialKey(job.id, randomUUID());
  await deps.profiles.adoptConversation(key, {
    owner,
    profileId: job.profile,
    kind: "task",
    participants: null,
  });
  const conversation = await run(deps.converse.ensure(key));
  const conversationId = String(conversation.id);
  // Held before the first input reaches the model.
  await deps.guard.add(conversationId);
  const agent = deps.profiles.agentFor(profile);
  const model = modelOf(deps, job, profile);
  await run(
    deps.converse.configure(conversation, {
      model: model?.id ?? null,
      effort: model === null || model.effort === "" ? null : (model.effort as ModelThinkingLevel),
      ...(agent.tools !== undefined ? { tools: agent.tools } : {}),
    }),
  );
  await run(deps.converse.turn(conversation, trialInputOf(job)));
  const entries = await run(deps.converse.entriesAfter(conversationId, 0, SCAN));
  const steps = projectTranscript(entries, undefined, false);
  const reply = steps
    .flatMap((step) => (step.kind === "output" && step.text !== "" ? [step.text] : []))
    .join("\n\n");
  const actions: TrialAction[] = steps
    .flatMap((step) =>
      step.kind === "tool" ? [{ name: step.step.name, input: keptInput(step.step.input) }] : [],
    )
    .slice(0, MAX_ACTIONS);
  return { reply: reply.slice(0, REPLY_CHARS), actions, error: null };
};

/** Keep a trial on its job, newest last; a job removed meanwhile keeps nothing. */
const recordTrial = async (
  converse: ConverseService,
  id: string,
  trial: RoutineTrial,
): Promise<void> => {
  const items = await readCronJobs(converse);
  if (!items.some((job) => job.id === id)) return;
  await run(
    writeCronJobs(
      converse,
      items.map((job) =>
        job.id === id
          ? { ...job, trials: [...(job.trials ?? []), trial].slice(-TRIALS_KEPT) }
          : job,
      ),
    ),
  );
};

export const trialsService = (deps: TrialDeps): TrialsService => {
  const listeners = new Set<() => void>();
  return {
    runCron: async (job) => {
      const at = Date.now();
      const row = await deps.profiles.rowOf(job.sessionId);
      let outcome: Omit<RoutineTrial, "at">;
      try {
        outcome =
          row === undefined
            ? { reply: "", actions: [], error: "This routine's chat no longer exists." }
            : await trialTurn(deps, job, row.owner);
      } catch (cause) {
        console.error(`trial of routine ${job.id} failed:`, cause);
        outcome = { reply: "", actions: [], error: ownerErrorText(cause) };
      }
      const trial: RoutineTrial = { at, ...outcome };
      await recordTrial(deps.converse, job.id, trial);
      for (const fn of listeners) {
        try {
          fn();
        } catch {
          // A listener never fails the trial.
        }
      }
      return trial;
    },
    onChange: (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
};
