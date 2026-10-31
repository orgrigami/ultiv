/** Cron routes: the registry, profile-stamped and rendered in the profile's timezone. */
import { isValidJobStart, nextFireTimes } from "@spreissen/mind";
import { createCronJob, listCronJobs, removeCronJob } from "../cron.ts";
import { queryOr, type RouteArgs } from "./types.ts";

export async function cronRoutes(
  args: RouteArgs,
  segment: (after: string) => string,
): Promise<boolean> {
  const { req, mind, scheduler, path, json } = args;
  const method = req.method ?? "GET";
  if (path === "/api/cron" && method === "GET") {
    const profile = queryOr(args, "profile");
    const jobs = await listCronJobs(mind.converse);
    json(200, profile !== undefined ? jobs.filter((job) => job.profile === profile) : jobs);
    return true;
  }
  if (path === "/api/cron" && method === "POST") {
    const body = await args.readJson<{
      sessionId?: string;
      schedule?: string;
      once?: number | null;
      prompt?: string;
    }>(req);
    if (
      body.sessionId === undefined ||
      body.prompt === undefined ||
      !isValidJobStart(body.schedule ?? "", body.once)
    ) {
      json(400, {
        error: "sessionId, prompt and a valid schedule (cron or future `once`) are required",
      });
      return true;
    }
    const job = await createCronJob(mind.converse, mind.profiles, {
      sessionId: body.sessionId,
      schedule: body.schedule ?? "",
      ...(body.once !== undefined && body.once !== null ? { once: body.once } : {}),
      prompt: body.prompt,
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
  if (path.startsWith("/api/cron/") && method === "DELETE") {
    const removed = await removeCronJob(mind.converse, segment("/api/cron/"));
    await scheduler.refresh();
    json(200, { ok: removed });
    return true;
  }
  return false;
}
