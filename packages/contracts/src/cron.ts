import { Type, type Static } from "typebox";
import { RoutineTrialSchema } from "./routine-trial.ts";

export { RoutineTrialSchema, TRIALS_KEPT } from "./routine-trial.ts";
export type { RoutineTrial, TrialAction } from "./routine-trial.ts";

/** One cron trigger: a schedule that delivers a prompt into a session. */
export const CronJobInfoSchema = Type.Object({
  id: Type.String(),
  sessionId: Type.String(),
  /** The profile whose timezone this schedule renders in. */
  profile: Type.String(),
  /** 5-field cron expression, interpreted in the profile's timezone. Empty for one-shot jobs. */
  schedule: Type.String(),
  /** One-shot epoch ms trigger; fires once, then the job removes itself. Null for recurring. */
  once: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  prompt: Type.String(),
  enabled: Type.Boolean(),
  /** Consecutive delivery failures; 3 auto-disables the job. */
  failures: Type.Number(),
  createdAt: Type.Number(),
  lastRunAt: Type.Union([Type.Number(), Type.Null()]),
  lastError: Type.Union([Type.String(), Type.Null()]),
  /**
   * Fire receipts: every actual fire increments these (write-ahead receipt in
   * the routine-events log), so a schedule that "never fired" is checkable.
   */
  fireCount: Type.Optional(Type.Number()),
  lastFiredAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  /** When the bot is mid-turn: steer the turn at the next boundary, or queue as follow-up. */
  whenBusy: Type.Optional(
    Type.Union([Type.Literal("steer"), Type.Literal("followUp"), Type.Literal("reject")]),
  ),
  /**
   * Where a fire runs: "chat" (absent on older jobs) wakes the bot in its main
   * chat on its chat model; "task" runs the prompt as a background task on the
   * bot's background model and posts the result into the main chat as a note,
   * without a main-chat turn.
   */
  run: Type.Optional(Type.Union([Type.Literal("chat"), Type.Literal("task")])),
  /**
   * Trial mode: every fire runs as a trial (routine-trial.ts) instead of for
   * real, until the owner turns the routine live. Absent = live.
   */
  trial: Type.Optional(Type.Boolean()),
  /** The latest trials, oldest first (at most TRIALS_KEPT). */
  trials: Type.Optional(Type.Array(RoutineTrialSchema)),
  /** The bot's project this routine serves (schedule_set `project`); its task fires carry it too. */
  projectId: Type.Optional(Type.String()),
});

export type CronJobInfo = Static<typeof CronJobInfoSchema>;

export const CronJobListSchema = Type.Array(CronJobInfoSchema);

export type CronJobList = Static<typeof CronJobListSchema>;
