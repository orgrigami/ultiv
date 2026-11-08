/**
 * Calendar awareness: a read-only ICS feed (Google, Fastmail, Radicale — any
 * provider's secret-iCal URL) kept server-side in `CALENDAR_ICS_URL`. The
 * plugin installs only when the URL is present. Minimal VEVENT parser: no
 * RRULE expansion — recurring events appear at their series start.
 */
import { arr, bool, nul, num, obj, opt, str, union } from "@earendil-works/pi-schema";
import { definePlugin, toolCapability, type Plugin } from "../plugin.ts";
import { defineTool, type Tool } from "../tool.ts";

export const calendarFeedUrl = (): string | null => {
  const configured = process.env.CALENDAR_ICS_URL?.trim();
  return configured !== undefined && configured !== "" ? configured : null;
};

export const calendarConfigured = (): boolean => calendarFeedUrl() !== null;

export interface IcsEvent {
  /** Stable event identity from the feed (UID) — the sensor dedup key. */
  readonly uid: string | null;
  readonly summary: string;
  readonly start: number;
  readonly end: number | null;
  readonly allDay: boolean;
  readonly location: string | null;
}

const unfold = (raw: string): readonly string[] => {
  const lines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] = `${lines[lines.length - 1]}${line.slice(1)}`;
    } else {
      lines.push(line);
    }
  }
  return lines;
};

/** ICS date forms: YYYYMMDD (all-day), YYYYMMDDTHHMMSSZ (UTC), floating local. */
export const parseIcsDate = (value: string): { at: number; allDay: boolean } | null => {
  const day = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (day !== null) {
    return {
      at: new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 0, 0, 0).getTime(),
      allDay: true,
    };
  }
  const stamp = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (stamp === null) return null;
  const [, y, mo, d, h, mi, s, zulu] = stamp;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${zulu === "Z" ? "Z" : ""}`;
  const at = new Date(iso).getTime();
  return Number.isNaN(at) ? null : { at, allDay: false };
};

/** Parse a VEVENT calendar into events with epoch-ms start/end. */
export const parseIcs = (raw: string): readonly IcsEvent[] => {
  const events: IcsEvent[] = [];
  let current: Record<string, string> | null = null;
  for (const line of unfold(raw)) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (current !== null && current.dtstart !== undefined) {
        const start = parseIcsDate(current.dtstart);
        if (start !== null) {
          const end = current.dtend !== undefined ? parseIcsDate(current.dtend) : null;
          events.push({
            uid: current.uid ?? null,
            summary: current.summary ?? "(untitled)",
            start: start.at,
            end: end?.at ?? null,
            allDay: start.allDay,
            location: current.location ?? null,
          });
        }
      }
      current = null;
      continue;
    }
    if (current === null) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).split(";")[0]?.toUpperCase() ?? "";
    const value = line.slice(colon + 1);
    if (["DTSTART", "DTEND", "SUMMARY", "LOCATION", "UID"].includes(name)) {
      current[name.toLowerCase()] = value;
    }
  }
  return events.sort((a, b) => a.start - b.start);
};

const Params = obj(
  {
    days: opt(num({ description: "How many days ahead to show, including today (default 1)." })),
    timezone: opt(str({ description: 'IANA zone for "today" (default: the server\u2019s zone).' })),
  },
  { open: true },
);

const eventsTool = (feedUrl: string): Tool =>
  defineTool({
    name: "calendar_events",
    description:
      "Your owner's calendar events for today (or the next few days) from their ICS feed. " +
      "Recurring events are NOT expanded (only a series' first occurrence is listed), so " +
      "never call a day free on this alone.",
    parameters: Params,
    structuredOutputSchema: arr(
      obj(
        {
          summary: str(),
          start: str(),
          end: union([str(), nul()]),
          allDay: bool(),
          location: union([str(), nul()]),
        },
        { open: true },
      ),
    ),
    execute: async (args) => {
      const days = Math.min(Math.max(Math.trunc(args.days ?? 1), 1), 14);
      const zone = args.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date());
      const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
      const dayStart = new Date(
        `${value("year")}-${value("month")}-${value("day")}T00:00:00`,
      ).getTime();
      const windowEnd = dayStart + days * 86_400_000;
      if (Number.isNaN(dayStart)) {
        return {
          output: [{ type: "text" as const, text: `invalid IANA timezone: ${zone}` }],
          isError: true as const,
        };
      }
      let raw: string;
      try {
        const response = await fetch(feedUrl, { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) {
          return {
            output: [{ type: "text" as const, text: `calendar feed returned ${response.status}` }],
            isError: true as const,
          };
        }
        raw = await response.text();
      } catch (cause) {
        return {
          output: [{ type: "text" as const, text: `calendar feed unreachable: ${String(cause)}` }],
          isError: true as const,
        };
      }
      const inWindow = parseIcs(raw)
        .filter((event) => event.start < windowEnd && (event.end ?? event.start) >= dayStart)
        .map((event) => ({
          summary: event.summary,
          start: new Date(event.start).toISOString(),
          end: event.end === null ? null : new Date(event.end).toISOString(),
          allDay: event.allDay,
          location: event.location,
        }));
      return {
        output: [{ type: "text" as const, text: JSON.stringify(inWindow) }],
        structuredOutput: inWindow,
      };
    },
  });

/** The calendar plugin: on only when CALENDAR_ICS_URL is set. */
export const calendarPlugin = (): Plugin =>
  definePlugin({
    id: "ultiv.calendar",
    version: "1.0.0",
    description: "Read-only calendar awareness over the owner's ICS feed (CALENDAR_ICS_URL).",
    capabilities: [toolCapability(eventsTool(calendarFeedUrl() as string))],
  });
