/** Sensor routes: the registry (polling lives in the server's sensor loop). */
import { listSensors, removeSensor } from "@spreissen/mind";
import type { RouteArgs } from "./types.ts";

export async function sensorRoutes(
  args: RouteArgs,
  segment: (after: string) => string,
): Promise<boolean> {
  const { req, mind, path, json } = args;
  const method = req.method ?? "GET";
  if (path === "/api/sensors" && method === "GET") {
    json(200, await listSensors(mind.converse));
    return true;
  }
  if (path.startsWith("/api/sensors/") && method === "DELETE") {
    json(200, { ok: await removeSensor(mind.converse, segment("/api/sensors/")) });
    return true;
  }
  return false;
}
