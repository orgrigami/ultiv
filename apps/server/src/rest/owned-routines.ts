/** The routine ids (cron jobs, webhooks, sensors) the caller owns, for receipt filtering. */
import { listCronJobs, listSensors, listWebhooks } from "@spreissen/mind";
import { ownedRecords } from "./owner-scope.ts";
import type { RouteArgs } from "./types.ts";

export const ownedRoutineIds = async (args: RouteArgs): Promise<ReadonlySet<string>> => {
  const { converse } = args.mind;
  const records = [
    ...(await listCronJobs(converse)),
    ...(await listWebhooks(converse)),
    ...(await listSensors(converse)),
  ];
  return new Set((await ownedRecords(args, records)).map((record) => record.id));
};
