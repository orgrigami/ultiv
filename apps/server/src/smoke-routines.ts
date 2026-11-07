// Routine trials on the running stack: a schedule created as a trial can be
// paused, tried now (the trial lands on the job; offline it records why it
// could not run) and turned live.

type Call = (
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<{ status: number; json: any }>;

export const smokeRoutines = async (
  call: Call,
  expect: (name: string, ok: boolean) => void,
  sessionId: string,
): Promise<void> => {
  const trialJob = await call("POST", "/api/cron", {
    sessionId,
    schedule: "0 9 * * *",
    prompt: "email the team",
    trial: true,
  });
  expect("cron trial create", trialJob.status === 200 && trialJob.json.trial === true);
  const paused = await call("PATCH", `/api/cron/${trialJob.json.id}`, { enabled: false });
  expect("cron pause", paused.status === 200 && paused.json.enabled === false);
  const tried = await call("POST", `/api/cron/${trialJob.json.id}/try`);
  expect("cron try now starts", tried.status === 202);
  let triedJob: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 100 && triedJob === undefined; attempt += 1) {
    const jobs = (await call("GET", "/api/cron")).json as Record<string, unknown>[];
    triedJob = jobs.find(
      (job) => job.id === trialJob.json.id && Array.isArray(job.trials) && job.trials.length > 0,
    );
    if (triedJob === undefined) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect("cron trial recorded on the job", triedJob !== undefined);
  const live = await call("PATCH", `/api/cron/${trialJob.json.id}`, { trial: false });
  expect("cron go live", live.status === 200 && live.json.trial === undefined);
  await call("DELETE", `/api/cron/${trialJob.json.id}`);
};
