/**
 * Routine trials: a routine's fire (a schedule's prompt, a watch's event, a
 * webhook's payload) run AS its bot, on the model and with the input the
 * live fire would use, in a fresh conversation the dry-run
 * guard holds (evals/guard.ts): every tool call is blocked before it runs,
 * so nothing is written, sent, spent or put up for approval. The owner reads
 * what the routine WOULD have done (its reply and each call it tried) before
 * letting it act. A routine in trial mode (`trial: true` on a schedule, a
 * watch or a webhook) runs every fire this way; "Try now" runs one of a
 * schedule on demand. Trial conversations are
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
import { updateSensor } from "../sensors/sensors.ts";
import { updateWebhook } from "../webhooks/webhooks.ts";

export type TrialDeps = {
  readonly converse: ConverseService;
  readonly profiles: ProfilesService;
  readonly guard: Pick<ReplayGuard, "add">;
  readonly knownModel: (ref: string) => boolean;
};

/**
 * Any routine a trial can run: a schedule, a watch (sensor) or a webhook,
 * with the exact input its live fire would deliver. A webhook's and a
 * watch's input is the wake text; a schedule's is `trialInputOf(job)`.
 */
export type TrialRoutine = {
  readonly kind: "cron" | "sensor" | "webhook";
  readonly id: string;
  readonly profile: string;
  readonly sessionId: string;
  readonly input: string;
  /** "task": the live fire runs as a background task (its model). */
  readonly run?: "chat" | "task" | undefined;
};

export interface TrialsService {
  /** Run one trial of any routine and keep it on the routine (newest last). */
  readonly run: (routine: TrialRoutine) => Promise<RoutineTrial>;
  /** Run one trial of a schedule and keep it on the job (newest last). */
  readonly runCron: (job: CronJobInfo) => Promise<RoutineTrial>;
  /** Hear a trial land on a job. Returns the unsubscribe. */
  readonly onChange: (fn: () => void) => () => void;
}

/** A trial's reply and each kept input stay small: they live on the job row. */
const REPLY_CHARS = 2_000;
const INPUT_CHARS = 600;
const MAX_ACTIONS = 12;
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
  routine: TrialRoutine,
  profile: Parameters<ProfilesService["agentFor"]>[0],
): TaskModel | null => {
  if (routine.run === "task") {
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
  routine: TrialRoutine,
  owner: string,
): Promise<Omit<RoutineTrial, "at">> => {
  const profile = await deps.profiles.get(owner, routine.profile);
  if (profile === undefined) return { reply: "", actions: [], error: "This bot no longer exists." };
  const key = trialKey(routine.id, randomUUID());
  await deps.profiles.adoptConversation(key, {
    owner,
    profileId: routine.profile,
    kind: "task",
    participants: null,
  });
  const conversation = await run(deps.converse.ensure(key));
  const conversationId = String(conversation.id);
  // Held before the first input reaches the model.
  await deps.guard.add(conversationId);
  // The trial meets the tools of the live fire: a chat's, or a task's.
  const agent = deps.profiles.agentFor(profile, routine.run === "task" ? "task" : "session");
  const model = modelOf(deps, routine, profile);
  await run(
    deps.converse.configure(conversation, {
      model: model?.id ?? null,
      effort: model === null || model.effort === "" ? null : (model.effort as ModelThinkingLevel),
      ...(agent.tools !== undefined ? { tools: agent.tools } : {}),
      ...(agent.modelTools !== undefined ? { modelTools: agent.modelTools } : {}),
    }),
  );
  await run(deps.converse.turn(conversation, routine.input));
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

/** The latest trials with one more, newest last. */
const kept = (trials: readonly RoutineTrial[] | undefined, trial: RoutineTrial): RoutineTrial[] =>
  [...(trials ?? []), trial].slice(-TRIALS_KEPT);

/** Keep a trial on its routine; a routine removed meanwhile keeps nothing. */
const recordTrial = async (
  converse: ConverseService,
  routine: TrialRoutine,
  trial: RoutineTrial,
): Promise<void> => {
  if (routine.kind === "sensor") {
    await updateSensor(converse, routine.id, (row) => ({
      ...row,
      trials: kept(row.trials, trial),
    }));
    return;
  }
  if (routine.kind === "webhook") {
    await updateWebhook(converse, routine.id, (row) => ({
      ...row,
      trials: kept(row.trials, trial),
    }));
    return;
  }
  const items = await readCronJobs(converse);
  if (!items.some((job) => job.id === routine.id)) return;
  await run(
    writeCronJobs(
      converse,
      items.map((job) =>
        job.id === routine.id ? { ...job, trials: kept(job.trials, trial) } : job,
      ),
    ),
  );
};

export const trialsService = (deps: TrialDeps): TrialsService => {
  const listeners = new Set<() => void>();
  const runOne = async (routine: TrialRoutine): Promise<RoutineTrial> => {
    const at = Date.now();
    const row = await deps.profiles.rowOf(routine.sessionId);
    let outcome: Omit<RoutineTrial, "at">;
    try {
      outcome =
        row === undefined
          ? { reply: "", actions: [], error: "This routine's chat no longer exists." }
          : await trialTurn(deps, routine, row.owner);
    } catch (cause) {
      console.error(`trial of routine ${routine.id} failed:`, cause);
      outcome = { reply: "", actions: [], error: ownerErrorText(cause) };
    }
    const trial: RoutineTrial = { at, ...outcome };
    await recordTrial(deps.converse, routine, trial);
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        // A listener never fails the trial.
      }
    }
    return trial;
  };
  return {
    run: (routine) => runOne(routine),
    runCron: (job) =>
      runOne({
        kind: "cron",
        id: job.id,
        profile: job.profile,
        sessionId: job.sessionId,
        input: trialInputOf(job),
        run: job.run,
      }),
    onChange: (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
};
