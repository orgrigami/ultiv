/** Sensor routes: the registry (polling lives in the server's sensor loop). */
import { listSensors, removeSensor, updateSensor } from "@spriessen/mind";
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
  // Pause/resume, and trial mode on or off ("Go live"); another owner's watch is a 404.
  if (path.startsWith("/api/sensors/") && method === "PATCH") {
    const id = segment("/api/sensors/");
    const mine = await findOwned(args, await listSensors(mind.converse), id);
    if (mine === undefined) {
      json(404, { error: "unknown watch" });
      return true;
    }
    const body = await args.readJson<{ enabled?: unknown; trial?: unknown }>(req);
    if (typeof body.enabled !== "boolean" && typeof body.trial !== "boolean") {
      json(400, { error: "send enabled and/or trial as true or false" });
      return true;
    }
    await updateSensor(mind.converse, id, (row) => {
      const { trial: _was, ...rest } = row;
      const trial = typeof body.trial === "boolean" ? body.trial : row.trial === true;
      return {
        ...rest,
        ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
        ...(trial ? { trial: true } : {}),
      };
    });
    json(200, (await listSensors(mind.converse)).find((row) => row.id === id) ?? null);
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
