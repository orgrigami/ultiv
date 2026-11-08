/**
 * Schedules as native tools: the entity sets its own alarms. Recurring jobs
 * are 5-field cron in the profile's timezone; one-shot jobs take an epoch-ms
 * `once`. Jobs deliver into the profile's main chat — the thinking happens
 * there, in the open. Create and remove are gated (they shape the owner's
 * future attention); listing is a read.
 */
import { arr, bool, nul, num, obj, oneOf, opt, str, union } from "@earendil-works/pi-schema";
import { defineTool, type Tool } from "@spriessen/ext";
import type { CronJobInfo } from "@spriessen/contracts";
import { isValidJobStart, nextFireTimes, type SchedulesService } from "./schedules.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import type { ProjectRef } from "../projects/links.ts";

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
  ...(job.trial === true ? { trial: true } : {}),
});

const SetParams = obj(
  {
    prompt: str({
      description:
        "What you should do when the schedule fires: you are woken with exactly this text, " +
        "so make it self-contained.",
    }),
    schedule: opt(
      str({
        description:
          '5-field cron expression, e.g. "30 9 * * 1" (09:30 on Mondays), in the profile\'s ' +
          "timezone. Required unless `once` is set.",
      }),
    ),
    once: opt(
      num({
        description:
          'Epoch ms for a ONE-SHOT trigger ("remind me in 2 hours"); the job removes itself ' +
          "after firing. Compute it from the `now` tool.",
      }),
    ),
    run: opt(
      oneOf(["task", "chat"], {
        description:
          "task (default): runs as a background task on your background model and posts its " +
          "result into your main chat as a note. chat: wakes you in your main chat, for routines " +
          "that need the conversation itself.",
      }),
    ),
    whenBusy: opt(
      oneOf(["steer", "followUp", "reject"], {
        description:
          "Mid-turn policy (default steer): a wake landing mid-turn joins the turn at the " +
          "next boundary (steer), waits for it to end (followUp), or is refused (reject).",
      }),
    ),
    project: opt(
      str({
        description:
          "The #handle of your open project this routine serves (a check-in, a weekly step); " +
          "the project's show then lists it.",
      }),
    ),
    trial: opt(
      bool({
        description:
          "Start as a trial: each run holds back every action and only records what you would " +
          "have done, until your owner turns it live under Routines. Use it for routines that " +
          "act on the world (send, post, buy, change things).",
      }),
    ),
  },
  { open: true },
);

const refused = (text: string) => ({
  output: [{ type: "text" as const, text }],
  isError: true as const,
});

const setTool = (
  schedules: SchedulesService,
  profiles: ProfilesService,
  projectRef: ProjectRef | undefined,
): Tool =>
  defineTool({
    name: "schedule_set",
    gated: true,
    description:
      "Schedule a future wake-up for yourself: a recurring cron schedule or a one-shot time. " +
      "When it fires, `prompt` runs as a background task (default) or wakes you in your main " +
      "chat (run: chat). Use " +
      "`now` to ground times; cron runs in your owner's time zone. Your owner approves " +
      "each schedule: first say in a sentence when it fires and what it will make you do.",
    parameters: SetParams,
    structuredOutputSchema: obj({ id: str(), next: arr(num()) }, { open: true }),
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
        return refused(reason);
      }
      let projectId: string | undefined;
      if (args.project !== undefined && args.project.trim() !== "") {
        if (projectRef === undefined) return refused("refused: projects are not available here");
        const target = await projectRef(scope, args.project);
        if (typeof target === "string") return refused(`refused: ${target}`);
        projectId = target.id;
      }
      const main = await profiles.ensureMain(scope.owner, scope.profileId);
      const job = await schedules.create({
        sessionId: main.id,
        schedule,
        prompt: args.prompt,
        ...(once !== null ? { once } : {}),
        ...(args.whenBusy !== undefined ? { whenBusy: args.whenBusy } : {}),
        run: args.run ?? "task",
        ...(args.trial === true ? { trial: true } : {}),
        ...(projectId !== undefined ? { projectId } : {}),
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
              `scheduled ${job.id}: ${once !== null ? `once at ${new Date(once).toISOString()}` : `cron "${schedule}"`}, ${job.run === "task" ? "runs as a background task reporting into" : "delivers into"} ${main.id}` +
              (next.length > 0 ? `\nnext fires: ${rendered} (verify this is what you meant)` : "") +
              (job.trial === true
                ? "\nit starts as a trial: runs record what you would do, nothing acts until your owner turns it live under Routines"
                : "\nyour owner sees this under Routines"),
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
    parameters: obj({}, { open: true }),
    structuredOutputSchema: arr(
      obj(
        {
          id: str(),
          schedule: str(),
          once: opt(num()),
          enabled: bool(),
          failures: num(),
          lastError: union([str(), nul()]),
          fireCount: num(),
          lastFiredAt: union([num(), nul()]),
        },
        { open: true },
      ),
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
    description: "Cancel one of YOUR schedules by id. Your owner approves each removal.",
    parameters: obj({ id: str({ description: "The schedule id." }) }, { open: true }),
    structuredOutputSchema: obj({ removed: bool() }, { open: true }),
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
  projectRef?: ProjectRef,
): readonly Tool[] => [
  setTool(schedules, profiles, projectRef),
  listTool(schedules, profiles),
  removeTool(schedules, profiles),
];
