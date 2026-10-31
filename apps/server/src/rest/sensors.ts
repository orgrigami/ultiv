/** Sensor routes: the registry (polling lives in the server's sensor loop). */
import { listSensors, removeSensor } from "@spreissen/mind";
import { findOwned, ownedRecords } from "./owner-scope.ts";
import type { RouteArgs } from "./types.ts";

export async function sensorRoutes(
  args: RouteArgs,
  segment: (after: string) => string,
): Promise<boolean> {
  const { req, mind, path, json } = args;
  const method = req.method ?? "GET";
  if (path === "/api/sensors" && method === "GET") {
    json(200, await ownedRecords(args, await listSensors(mind.converse)));
    return true;
  }
  if (path.startsWith("/api/sensors/") && method === "DELETE") {
    const id = segment("/api/sensors/");
    const mine = await findOwned(args, await listSensors(mind.converse), id);
    json(200, { ok: mine !== undefined && (await removeSensor(mind.converse, id)) });
    return true;
  }
  return false;
}
