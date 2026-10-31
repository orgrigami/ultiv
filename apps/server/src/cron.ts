/**
 * Cron triggers: the server half of the schedules faculty. Jobs live in the
 * mind's durable registry doc (@spreissen/mind schedules — CRUD there, tools on
 * top of it); this module arms one croner timer per enabled job, fires
 * deliveries through the same path as webhooks, and records the outcome.
 * Restarting re-arms everything from the doc. One-shot jobs (`once`) fire at
 * their epoch ms and remove themselves on success.
 */
import { Cron } from "croner";
import type { CronJobInfo } from "@spreissen/contracts";
import type { MindService } from "@spreissen/mind";
import {
  isValidSchedule,
  listCronJobs,
  readCronJobs,
  recordRoutineFire,
  removeCronJob,
  settleRoutineEvent,
  writeCronJobs,
} from "@spreissen/mind";
import { Effect } from "effect";
import { deliverToSession } from "./deliver.ts";

export {
  createCronJob,
  isValidSchedule,
  listCronJobs,
  removeCronJob,
  removeCronJobsForSessions,
} from "@spreissen/mind";

const setJobOutcome = async (
  mind: MindService,
  id: string,
  outcome: {
    lastRunAt: number;
    lastError: string | null;
    failuresReset?: boolean;
    failures?: number;
    disable?: boolean;
    fired?: boolean;
  },
): Promise<void> => {
  const items = await readCronJobs(mind.converse);
  await Effect.runPromise(
    writeCronJobs(
      mind.converse,
      items.map((job) => {
        if (job.id !== id) return job;
        const failures = outcome.failuresReset ? 0 : (outcome.failures ?? job.failures);
        return {
          ...job,
          lastRunAt: outcome.lastRunAt,
          lastError: outcome.lastError,
          failures,
          enabled: outcome.disable === true ? false : job.enabled,
          fireCount: (job.fireCount ?? 0) + (outcome.fired === true ? 1 : 0),
          lastFiredAt: outcome.fired === true ? outcome.lastRunAt : (job.lastFiredAt ?? null),
        };
      }),
    ),
  );
};

export interface CronScheduler {
  /** Re-arm every enabled job (after create/remove/toggle). */
  readonly refresh: () => Promise<void>;
  readonly stop: () => void;
}

/** Consecutive failures before a job disables itself and pages the owner. */
const MAX_CONSECUTIVE_FAILURES = 3;

const armedJob = (mind: MindService, job: CronJobInfo, scheduler: CronScheduler): Cron => {
  const fire = async (): Promise<void> => {
    // WRITE-AHEAD: the fire receipt exists before the delivery — a crash
    // mid-flight leaves a visible "accepted" receipt, never silence.
    const eventId = await recordRoutineFire(mind.converse, {
      routineId: job.id,
      source: "cron",
    });
    try {
      await deliverToSession(
        mind,
        job.sessionId,
        `[cron ${job.id}] ${job.prompt}`,
        job.whenBusy ?? "steer",
        "cron",
      );
      await settleRoutineEvent(mind.converse, eventId, "delivered");
      // A one-shot's whole purpose is that single delivery — retire it.
      if (job.once !== undefined && job.once !== null) {
        await removeCronJob(mind.converse, job.id);
      } else {
        await setJobOutcome(mind, job.id, {
          lastRunAt: Date.now(),
          lastError: null,
          failuresReset: true,
          fired: true,
        });
      }
    } catch (cause) {
      const failures = job.failures + 1;
      const error = String(cause).slice(0, 300);
      const disable = failures >= MAX_CONSECUTIVE_FAILURES;
      await settleRoutineEvent(mind.converse, eventId, "failed", error);
      await setJobOutcome(mind, job.id, {
        lastRunAt: Date.now(),
        lastError: error,
        failures,
        // A failed one-shot must DEAD-LETTER, not vanish or retry forever:
        // disable it (job stays listed, visibly dead) after the cap.
        ...(disable ? { disable } : {}),
      });
      if (disable) {
        // The attention path: silence must eventually page the owner.
        mind.audit.record({
          at: Date.now(),
          kind: "escalation",
          conversationId: "cron",
          profile: job.profile,
          callId: job.id,
          name: "cron-disabled",
          durationMs: null,
          ok: false,
          error: `${MAX_CONSECUTIVE_FAILURES} consecutive failures: ${error}`,
        });
        console.error(`cron ${job.id} disabled after ${failures} consecutive failures`);
      }
    }
  };
  // Schedules render in the profile's timezone ("morning" means the owner's morning).
  const timezoneOf = async (): Promise<string | undefined> => {
    const row = await mind.profiles.rowOf(job.sessionId);
    const profile = row !== undefined ? await mind.profiles.get(row.owner, job.profile) : undefined;
    return profile?.timezone;
  };
  const isOnce = job.once !== undefined && job.once !== null;
  let timer: Cron | undefined;
  const arm = (): void => {
    if (isOnce) {
      // A past `once` fires immediately (croner semantics) — a restart
      // retries a delivery that never succeeded.
      timer = new Cron(new Date(job.once as number), () => {
        void fire().finally(() => void scheduler.refresh());
      });
      return;
    }
    void timezoneOf().then((timezone) => {
      timer = new Cron(
        job.schedule,
        { paused: !job.enabled, ...(timezone !== undefined ? { timezone } : {}) },
        () => {
          void fire().finally(() => void scheduler.refresh());
        },
      );
    });
  };
  arm();
  // A thin stop-capable stand-in: the scheduler only ever calls stop().
  return { stop: () => timer?.stop() } as unknown as Cron;
};

/** Arm the scheduler over every registered job; refresh after registry changes. */
export const startScheduler = async (mind: MindService): Promise<CronScheduler> => {
  const timers = new Map<string, Cron>();
  const armable = (job: CronJobInfo): boolean => {
    if (!job.enabled) return false;
    return job.once !== undefined && job.once !== null ? true : isValidSchedule(job.schedule);
  };
  const refresh = async (): Promise<void> => {
    for (const timer of timers.values()) timer.stop();
    timers.clear();
    for (const job of await listCronJobs(mind.converse)) {
      if (!armable(job)) continue;
      timers.set(job.id, armedJob(mind, job, scheduler));
    }
  };
  const scheduler: CronScheduler = {
    refresh: () => refresh(),
    stop: () => {
      for (const timer of timers.values()) timer.stop();
      timers.clear();
    },
  };
  await refresh();
  return scheduler;
};
