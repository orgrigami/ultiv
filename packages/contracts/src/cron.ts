import {
  arr,
  bool,
  nul,
  num,
  obj,
  oneOf,
  opt,
  str,
  union,
  type Static,
} from "@earendil-works/pi-schema";
import { RoutineTrialSchema } from "./routine-trial.ts";

export { RoutineTrialSchema, TRIALS_KEPT } from "./routine-trial.ts";
export type { RoutineTrial, TrialAction } from "./routine-trial.ts";

/** One cron trigger: a schedule that delivers a prompt into a session. */
export const CronJobInfoSchema = obj(
  {
    id: str(),
    sessionId: str(),
    /** The profile whose timezone this schedule renders in. */
    profile: str(),
    /** 5-field cron expression, interpreted in the profile's timezone. Empty for one-shot jobs. */
    schedule: str(),
    /** One-shot epoch ms trigger; fires once, then the job removes itself. Null for recurring. */
    once: opt(union([num(), nul()])),
    prompt: str(),
    enabled: bool(),
    /** Consecutive delivery failures; 3 auto-disables the job. */
    failures: num(),
    createdAt: num(),
    lastRunAt: union([num(), nul()]),
    lastError: union([str(), nul()]),
    /**
     * Fire receipts: every actual fire increments these (write-ahead receipt in
     * the routine-events log), so a schedule that "never fired" is checkable.
     */
    fireCount: opt(num()),
    lastFiredAt: opt(union([num(), nul()])),
    /** When the bot is mid-turn: steer the turn at the next boundary, or queue as follow-up. */
    whenBusy: opt(oneOf(["steer", "followUp", "reject"])),
    /**
     * Where a fire runs: "chat" (absent on older jobs) wakes the bot in its main
     * chat on its chat model; "task" runs the prompt as a background task on the
     * bot's background model and posts the result into the main chat as a note,
     * without a main-chat turn.
     */
    run: opt(oneOf(["chat", "task"])),
    /**
     * Trial mode: every fire runs as a trial (routine-trial.ts) instead of for
     * real, until the owner turns the routine live. Absent = live.
     */
    trial: opt(bool()),
    /** The latest trials, oldest first (at most TRIALS_KEPT). */
    trials: opt(arr(RoutineTrialSchema)),
    /** The bot's project this routine serves (schedule_set `project`); its task fires carry it too. */
    projectId: opt(str()),
  },
  { open: true },
);

export type CronJobInfo = Static<typeof CronJobInfoSchema>;

export const CronJobListSchema = arr(CronJobInfoSchema);

export type CronJobList = Static<typeof CronJobListSchema>;
