/**
 * Temporal awareness: the one fact no model carries with it — what time it is
 * right now. A first-party read tool, so every "today", "deadline" and
 * freshness judgment grounds in the server clock, in any IANA zone.
 */
import { Type } from "typebox";
import type { Static } from "typebox";
import { definePlugin, toolCapability, type Plugin } from "@spreissen/ext";
import { defineTool, type Tool } from "@spreissen/ext";

const NowParams = Type.Object({
  timezone: Type.Optional(
    Type.String({
      description: 'IANA timezone (e.g. "Asia/Jakarta"); default is the server\u2019s zone.',
    }),
  ),
});

const NowOutput = Type.Object({
  utc: Type.String({ description: "UTC instant, ISO 8601." }),
  epochMs: Type.Number(),
  timezone: Type.String(),
  offsetMinutes: Type.Number(),
  local: Type.String({ description: "Local date-time in the zone, ISO-like." }),
  weekday: Type.String(),
});

type NowResult = Static<typeof NowOutput>;

const zoneInfo = (
  zone: string,
  at: Date,
): { timezone: string; offsetMinutes: number; local: string; weekday: string } => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "longOffset",
  }).formatToParts(at);
  const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  // "longOffset" renders as "GMT+07:00" (plain "GMT" at UTC). An unparseable
  // name counts as zero — the local clock fields stay authoritative.
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(value("timeZoneName"));
  const sign = match?.[1] === "-" ? -1 : 1;
  const offsetMinutes = match === null ? 0 : sign * (Number(match[2]) * 60 + Number(match[3]));
  return {
    timezone: zone,
    offsetMinutes,
    local: `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}:${value("second")}`,
    weekday: value("weekday"),
  };
};

/** The `now` tool: the current instant, zone offset, local time and weekday. */
export const nowTool = (): Tool =>
  defineTool({
    name: "now",
    description:
      "Your sense of now: the current date, time, weekday and UTC offset, in any IANA zone " +
      "(default: the server\u2019s — pass your owner\u2019s zone when you know it). Ground every " +
      '"today", deadline, schedule or freshness claim in this instead of assuming.',
    parameters: NowParams,
    structuredOutputSchema: NowOutput,
    execute: (args) => {
      try {
        const at = new Date();
        const zone = args.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
        const output: NowResult = {
          utc: at.toISOString(),
          epochMs: at.getTime(),
          ...zoneInfo(zone, at),
        };
        return Promise.resolve({
          output: [{ type: "text" as const, text: JSON.stringify(output) }],
          structuredOutput: output,
        });
      } catch {
        const reason = `invalid IANA timezone: ${args.timezone ?? "(unspecified)"}`;
        return Promise.resolve({
          output: [{ type: "text" as const, text: reason }],
          isError: true as const,
        });
      }
    },
  });

/** Temporal awareness as an installable plugin; needs no key, always on. */
export const temporalPlugin = (): Plugin =>
  definePlugin({
    id: "ultiv.mind.temporal",
    version: "1.0.0",
    description: "The entity's temporal awareness: a `now` tool grounding date and time claims.",
    capabilities: [toolCapability(nowTool())],
  });
