/**
 * Schedules as native tools: the entity sets its own alarms. Recurring jobs
 * are 5-field cron in the profile's timezone; one-shot jobs take an epoch-ms
 * `once`. Jobs deliver into the profile's main chat — the thinking happens
 * there, in the open. Create and remove are gated (they shape the owner's
 * future attention); listing is a read.
 */
import { Type } from "typebox";
import { defineTool, type Tool } from "@spreissen/ext";
import type { CronJobInfo } from "@spreissen/contracts";
import { isValidJobStart, nextFireTimes, type SchedulesService } from "./schedules.ts";
import type { ProfilesService } from "../profiles/profiles.ts";

const scopeOfOrNone = (profiles: ProfilesService, conversationId: string) =>
  profiles.scopeOf(conversationId);

const jobSummary = (job: CronJobInfo): Record<string, unknown> => ({
  id: job.id,
  schedule: job.schedule,
  ...(job.once !== undefined && job.once !== null ? { once: job.once } : {}),
  enabled: job.enabled,
  failures: job.failures,
  lastError: job.lastError,
  fireCount: job.fireCount ?? 0,
  lastFiredAt: job.lastFiredAt ?? null,
});

const SetParams = Type.Object({
  prompt: Type.String({
    description:
      "What you should do when the schedule fires — you are woken with exactly this text, " +
      "so make it self-contained.",
  }),
  schedule: Type.Optional(
    Type.String({
      description:
        '5-field cron expression, e.g. "30 9 * * 1" (09:30 on Mondays), in the profile\'s ' +
        "timezone. Required unless `once` is set.",
    }),
  ),
  once: Type.Optional(
    Type.Number({
      description:
        'Epoch ms for a ONE-SHOT trigger ("remind me in 2 hours"); the job removes itself ' +
        "after firing. Compute it from the `now` tool.",
    }),
  ),
  whenBusy: Type.Optional(
    Type.Union([Type.Literal("steer"), Type.Literal("followUp"), Type.Literal("reject")], {
      description:
        "Mid-turn policy (default steer): a wake landing mid-turn joins the turn at the " +
        "next boundary (steer), waits for it to end (followUp), or is refused (reject).",
    }),
  ),
});

const setTool = (schedules: SchedulesService, profiles: ProfilesService): Tool =>
  defineTool({
    name: "schedule_set",
    gated: true,
    description:
      "Schedule a future wake-up for yourself: a recurring cron schedule or a one-shot time. " +
      "When it fires, `prompt` arrives in your main chat as an input and you act on it. Use " +
      "`now` to ground times; cron renders in the profile's timezone. The owner approves " +
      "each schedule: first say in a sentence when it fires and what it will make you do.",
    parameters: SetParams,
    structuredOutputSchema: Type.Object({ id: Type.String(), next: Type.Array(Type.Number()) }),
    execute: async (args, api) => {
      const scope = profiles.scopeOf(String(api.conversationId));
      if (scope === undefined) {
        return {
          output: [
            { type: "text" as const, text: "refused: this conversation belongs to no profile." },
          ],
          isError: true as const,
        };
      }
      const once = args.once ?? null;
      const schedule = args.schedule ?? "";
      if (!isValidJobStart(schedule, once)) {
        const reason =
          once !== null
            ? "refused: `once` must be a future epoch-ms timestamp."
            : `refused: invalid cron expression "${schedule}".`;
        return { output: [{ type: "text" as const, text: reason }], isError: true as const };
      }
      const main = await profiles.ensureMain(scope.owner, scope.profileId);
      const job = await schedules.create({
        sessionId: main.id,
        schedule,
        prompt: args.prompt,
        ...(once !== null ? { once } : {}),
        ...(args.whenBusy !== undefined ? { whenBusy: args.whenBusy } : {}),
      });
      // Creation-time preview: the author verifies "daily 9am" in the
      // profile's timezone BEFORE trusting the schedule.
      const profile = await profiles.get(scope.owner, scope.profileId);
      const next = nextFireTimes(
        { schedule, ...(once !== null ? { once } : {}) },
        profile?.timezone,
      );
      const rendered = next.map((at) => new Date(at).toISOString()).join(", ");
      return {
        output: [
          {
            type: "text" as const,
            text:
              `scheduled ${job.id}: ${once !== null ? `once at ${new Date(once).toISOString()}` : `cron "${schedule}"`} — delivers into ${main.id}` +
              (next.length > 0 ? `\nnext fires: ${rendered} (verify this is what you meant)` : "") +
              "\nyour owner sees this under Routines",
          },
        ],
        structuredOutput: { id: job.id, next },
      };
    },
  });

const listTool = (schedules: SchedulesService, profiles: ProfilesService): Tool =>
  defineTool({
    name: "schedule_list",
    description: "List YOUR schedules (this profile's cron jobs and one-shots).",
    parameters: Type.Object({}),
    structuredOutputSchema: Type.Array(
      Type.Object({
        id: Type.String(),
        schedule: Type.String(),
        once: Type.Optional(Type.Number()),
        enabled: Type.Boolean(),
        failures: Type.Number(),
        lastError: Type.Union([Type.String(), Type.Null()]),
        fireCount: Type.Number(),
        lastFiredAt: Type.Union([Type.Number(), Type.Null()]),
      }),
    ),
    execute: async (_args, api) => {
      const scope = scopeOfOrNone(profiles, String(api.conversationId));
      if (scope === undefined) {
        return {
          output: [
            { type: "text" as const, text: "refused: this conversation belongs to no profile." },
          ],
          structuredOutput: [],
        };
      }
      const jobs = (await schedules.list()).filter((job) => job.profile === scope.profileId);
      return {
        output: [{ type: "text" as const, text: JSON.stringify(jobs.map(jobSummary)) }],
        structuredOutput: jobs.map((job) => ({
          id: job.id,
          schedule: job.schedule,
          ...(job.once !== undefined && job.once !== null ? { once: job.once } : {}),
          enabled: job.enabled,
          failures: job.failures,
          lastError: job.lastError,
          fireCount: job.fireCount ?? 0,
          lastFiredAt: job.lastFiredAt ?? null,
        })),
      };
    },
  });

const removeTool = (schedules: SchedulesService, profiles: ProfilesService): Tool =>
  defineTool({
    name: "schedule_remove",
    gated: true,
    description: "Cancel one of YOUR schedules by id. The user approves each removal.",
    parameters: Type.Object({ id: Type.String({ description: "The schedule id." }) }),
    structuredOutputSchema: Type.Object({ removed: Type.Boolean() }),
    execute: async (args, api) => {
      const scope = scopeOfOrNone(profiles, String(api.conversationId));
      if (scope === undefined) {
        return {
          output: [
            { type: "text" as const, text: "refused: this conversation belongs to no profile." },
          ],
          isError: true as const,
        };
      }
      const job = (await schedules.list()).find(
        (candidate) => candidate.id === args.id && candidate.profile === scope.profileId,
      );
      if (job === undefined) {
        return {
          output: [{ type: "text" as const, text: `no schedule ${args.id} of yours` }],
          isError: true as const,
        };
      }
      const removed = await schedules.remove(args.id);
      return {
        output: [{ type: "text" as const, text: removed ? `removed ${args.id}` : "not found" }],
        structuredOutput: { removed },
      };
    },
  });

/** The schedule tools in registry order. */
export const scheduleTools = (
  schedules: SchedulesService,
  profiles: ProfilesService,
): readonly Tool[] => [
  setTool(schedules, profiles),
  listTool(schedules, profiles),
  removeTool(schedules, profiles),
];
