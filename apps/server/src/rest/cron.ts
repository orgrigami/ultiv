/** Cron routes: the registry, profile-stamped and rendered in the profile's timezone. */
import { isValidJobStart, nextFireTimes, setCronEnabled, setCronTrial } from "@spriessen/mind";
import { createCronJob, listCronJobs, removeCronJob } from "../cron.ts";
import { findOwned, ownedRecords, ownedTarget } from "./owner-scope.ts";
import { queryOr, type RouteArgs } from "./types.ts";

export async function cronRoutes(
  args: RouteArgs,
  segment: (after: string) => string,
): Promise<boolean> {
  const { req, mind, scheduler, path, json } = args;
  const method = req.method ?? "GET";
  if (path === "/api/cron" && method === "GET") {
    const profile = queryOr(args, "profile");
    const jobs = await ownedRecords(args, await listCronJobs(mind.converse));
    json(200, profile !== undefined ? jobs.filter((job) => job.profile === profile) : jobs);
    return true;
  }
  if (path === "/api/cron" && method === "POST") {
    const body = await args.readJson<{
      sessionId?: string;
      schedule?: string;
      once?: number | null;
      prompt?: string;
      run?: string;
      trial?: boolean;
    }>(req);
    if (
      body.sessionId === undefined ||
      body.prompt === undefined ||
      (body.run !== undefined && body.run !== "chat" && body.run !== "task") ||
      !isValidJobStart(body.schedule ?? "", body.once)
    ) {
      json(400, {
        error:
          "sessionId, prompt and a valid schedule (cron or future `once`) are required; run is chat or task",
      });
      return true;
    }
    const target = await ownedTarget(args, body.sessionId);
    if (target === undefined) {
      json(404, { error: "unknown session" });
      return true;
    }
    const job = await createCronJob(mind.converse, mind.profiles, {
      sessionId: target,
      schedule: body.schedule ?? "",
      ...(body.once !== undefined && body.once !== null ? { once: body.once } : {}),
      prompt: body.prompt,
      ...(body.run === "chat" || body.run === "task" ? { run: body.run } : {}),
      ...(body.trial === true ? { trial: true } : {}),
    });
    await scheduler.refresh();
    // Creation-time preview: the caller verifies the schedule means what
    // they think (rendered in the profile's timezone) before trusting it.
    const row = await mind.profiles.rowOf(job.sessionId);
    const profile = row !== undefined ? await mind.profiles.get(row.owner, job.profile) : undefined;
    json(200, {
      ...job,
      next: nextFireTimes(
        { schedule: job.schedule, ...(job.once !== null ? { once: job.once } : {}) },
        profile?.timezone,
      ),
    });
    return true;
  }
  if (await cronEditRoutes(args)) return true;
  if (path.startsWith("/api/cron/") && method === "DELETE") {
    const id = segment("/api/cron/");
    // Another owner's job answers like a missing one: { ok: false }.
    const mine = await findOwned(args, await listCronJobs(mind.converse), id);
    const removed = mine !== undefined && (await removeCronJob(mind.converse, id));
    if (removed) await scheduler.refresh();
    json(200, { ok: removed });
    return true;
  }
  return false;
}

const TRY_PATH = /^\/api\/cron\/([^/]+)\/try$/;
const ONE_PATH = /^\/api\/cron\/([^/]+)$/;

/** Schedules with a trial running now, so a second Try waits for the first. */
const trying = new Set<string>();

/**
 * PATCH /api/cron/:id { enabled?, trial? }: pause/resume, and trial mode on
 * or off ("Go live"); POST /api/cron/:id/try: run one trial now, in the
 * background (202; the result lands on the job and the `routines` live
 * signal fires). Another owner's job answers like a missing one (404).
 */
async function cronEditRoutes(args: RouteArgs): Promise<boolean> {
  const { req, mind, scheduler, path, json } = args;
  const method = req.method ?? "GET";
  const tried = method === "POST" ? path.match(TRY_PATH) : null;
  const patched = method === "PATCH" ? path.match(ONE_PATH) : null;
  const id = decodeURIComponent((tried ?? patched)?.[1] ?? "");
  if (id === "") return false;
  const job = await findOwned(args, await listCronJobs(mind.converse), id);
  if (job === undefined) {
    json(404, { error: "unknown schedule" });
    return true;
  }
  if (tried !== null) {
    if (trying.has(id)) {
      json(409, { error: "a trial of this schedule is already running" });
      return true;
    }
    trying.add(id);
    void mind.trials
      .runCron(job)
      .catch((cause: unknown) => console.error(`trial of ${id} failed:`, cause))
      .finally(() => trying.delete(id));
    json(202, { started: true });
    return true;
  }
  const body = await args.readJson<{ enabled?: unknown; trial?: unknown }>(req);
  const enabled = typeof body.enabled === "boolean" ? body.enabled : undefined;
  const trial = typeof body.trial === "boolean" ? body.trial : undefined;
  if (enabled === undefined && trial === undefined) {
    json(400, { error: "send enabled and/or trial as true or false" });
    return true;
  }
  if (trial !== undefined && !(await setCronTrial(mind.converse, id, trial))) {
    json(400, { error: "a one-time schedule cannot run as a trial" });
    return true;
  }
  if (enabled !== undefined) await setCronEnabled(mind.converse, id, enabled);
  await scheduler.refresh();
  json(200, (await listCronJobs(mind.converse)).find((row) => row.id === id) ?? null);
  return true;
}
