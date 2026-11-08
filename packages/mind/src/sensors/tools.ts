/**
 * Sensors as native tools: the entity watches external sources (today: the
 * owner's calendar ICS feed) and gets woken before matching events. Set and
 * remove are gated (they shape future attention); listing is a read. The
 * source's own event ids dedup fires — each real-world event wakes once.
 */
import { arr, bool, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { defineTool, type Tool } from "@spriessen/ext";
import type { SensorInfo } from "@spriessen/contracts";
import type { SensorsService } from "./sensors.ts";
import type { ProfilesService } from "../profiles/profiles.ts";

const sensorSummary = (sensor: SensorInfo): Record<string, unknown> => ({
  id: sensor.id,
  kind: sensor.kind,
  ...(sensor.url !== null && sensor.url !== "" ? { url: sensor.url } : {}),
  match: sensor.match === "" ? "(any event)" : sensor.match,
  leadMinutes: sensor.leadMinutes,
  enabled: sensor.enabled,
  fireCount: sensor.fireCount,
  lastFiredAt: sensor.lastFiredAt,
  lastError: sensor.lastError,
});

const setTool = (sensors: SensorsService, profiles: ProfilesService): Tool =>
  defineTool({
    name: "sensor_set",
    gated: true,
    description:
      "Watch a source and get woken on events. kind 'calendar' watches the owner's ICS feed " +
      "(woken `leadMinutes` before matching events); kind 'rss' watches `url` and wakes on " +
      "every new item whose title contains `match`; kind 'watch' polls `url` and wakes once " +
      "each time its content CHANGES (edge-triggered: the first poll is the baseline). Each " +
      "event/change wakes you exactly once, even across restarts. The owner approves each " +
      "sensor: first say in a sentence what it watches and when it will wake you.",
    parameters: obj(
      {
        kind: opt(
          oneOf(["calendar", "rss", "watch"], {
            description: "Source family (default calendar).",
          }),
        ),
        url: opt(str({ description: "rss/watch only: the URL to poll (http/https)." })),
        match: opt(
          str({
            description:
              "Case-insensitive substring filter: event/item title (calendar/rss) or page text (watch). Empty = everything.",
          }),
        ),
        leadMinutes: opt(
          num({
            description: "calendar only: minutes before the event to wake (default 10, max 1440).",
          }),
        ),
        trial: opt(
          bool({
            description:
              "Start as a trial: each event runs with every action held back and only records " +
              "what you would have done, until your owner turns it live under Routines.",
          }),
        ),
      },
      { open: true },
    ),
    structuredOutputSchema: obj({ id: str() }, { open: true }),
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
      const main = await profiles.ensureMain(scope.owner, scope.profileId);
      const kind = args.kind ?? "calendar";
      if (
        (kind === "rss" || kind === "watch") &&
        (args.url === undefined || args.url.trim() === "")
      ) {
        return {
          output: [{ type: "text" as const, text: `refused: ${kind} sensors need a url.` }],
          isError: true as const,
        };
      }
      try {
        const sensor = await sensors.create({
          sessionId: main.id,
          kind,
          ...(kind === "rss" || kind === "watch" ? { url: args.url ?? "" } : {}),
          match: args.match ?? "",
          ...(args.leadMinutes !== undefined ? { leadMinutes: args.leadMinutes } : {}),
          ...(args.trial === true ? { trial: true } : {}),
        });
        return {
          output: [
            {
              type: "text" as const,
              text: `sensor ${sensor.id} watching ${sensor.kind}${sensor.url !== null && sensor.url !== "" ? ` ${sensor.url}` : ""}${sensor.match === "" ? " (everything)" : ` for "${sensor.match}"`} — fires into ${main.id}${sensor.trial === true ? " (as a trial: nothing acts until your owner turns it live)" : ""}`,
            },
          ],
          structuredOutput: { id: sensor.id },
        };
      } catch (cause) {
        return {
          output: [{ type: "text" as const, text: `refused: ${String(cause).slice(0, 200)}` }],
          isError: true as const,
        };
      }
    },
  });

const listTool = (sensors: SensorsService, profiles: ProfilesService): Tool =>
  defineTool({
    name: "sensor_list",
    description: "List YOUR sensors with their fire counts and last errors.",
    parameters: obj({}, { open: true }),
    structuredOutputSchema: arr(obj({ id: str(), fireCount: num() }, { open: true })),
    execute: async (_args, api) => {
      const scope = profiles.scopeOf(String(api.conversationId));
      if (scope === undefined) {
        return {
          output: [
            { type: "text" as const, text: "refused: this conversation belongs to no profile." },
          ],
          structuredOutput: [],
        };
      }
      const mine = (await sensors.list()).filter((s) => s.profile === scope.profileId);
      return {
        output: [{ type: "text" as const, text: JSON.stringify(mine.map(sensorSummary)) }],
        structuredOutput: mine.map((s) => ({ id: s.id, fireCount: s.fireCount })),
      };
    },
  });

const removeTool = (sensors: SensorsService, profiles: ProfilesService): Tool =>
  defineTool({
    name: "sensor_remove",
    gated: true,
    description: "Cancel one of YOUR sensors by id. The owner approves each removal.",
    parameters: obj(
      {
        id: str({ description: "The sensor id (see sensor_list)." }),
      },
      { open: true },
    ),
    structuredOutputSchema: obj({ removed: bool() }, { open: true }),
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
      const sensor = (await sensors.list()).find(
        (candidate) => candidate.id === args.id && candidate.profile === scope.profileId,
      );
      if (sensor === undefined) {
        return {
          output: [{ type: "text" as const, text: `no sensor ${args.id} of yours` }],
          isError: true as const,
        };
      }
      const removed = await sensors.remove(args.id);
      return {
        output: [{ type: "text" as const, text: removed ? `removed ${args.id}` : "not found" }],
        structuredOutput: { removed },
      };
    },
  });

/** The sensor tools in registry order. */
export const sensorTools = (
  sensors: SensorsService,
  profiles: ProfilesService,
): readonly Tool[] => [
  setTool(sensors, profiles),
  listTool(sensors, profiles),
  removeTool(sensors, profiles),
];
