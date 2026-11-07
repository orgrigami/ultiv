/**
 * Readers the tool presentation lens shares: record and flat values of a
 * call's input and output, clipping, hosts, the parsed JSON of a result, the
 * error a failed call reported, and an input shaped as labelled fields.
 */

import type { ToolStep } from "@spriessen/contracts";

import type { RecordField } from "./tool-text.ts";

export const recordOf = (input: unknown): Record<string, unknown> =>
  typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};

/** A field as one line: newlines and runs of space collapse. */
export const flatOf = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const flat = value.replace(/\s+/g, " ").trim();
  return flat === "" ? undefined : flat;
};

/** A field kept as written (bodies, transcripts): trimmed only. */
export const rawOf = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  return raw === "" ? undefined : raw;
};

export const clip = (value: string | undefined, max: number): string | undefined => {
  if (value === undefined) return undefined;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

export const hostOf = (url: string | undefined): string | undefined => {
  if (url === undefined) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return clip(url, 40);
  }
};

/** The output as JSON when it parses; undefined otherwise. */
export const jsonOf = (step: ToolStep): unknown => {
  const raw = rawOf(step.output);
  if (raw === undefined || !raw.startsWith("{")) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
};

/** The owner-facing error line: the payload's own words when it has them. */
/**
 * The output worth showing under a call's error line: none when the output
 * is nothing but that error (a refusal, a "split it" note), so the same
 * sentence never shows twice.
 */
export function outputBesidesError(step: ToolStep): string | undefined {
  const raw = rawOf(step.output);
  if (raw === undefined) return undefined;
  const error = errorTextOf(step);
  if (error === undefined) return raw;
  if (raw === error) return undefined;
  // `{ "error": "…" }` and nothing else says only what the error line says.
  const parsed = jsonOf(step);
  if (typeof parsed === "object" && parsed !== null) {
    const keys = Object.keys(parsed);
    if (keys.length === 1 && keys[0] === "error") return undefined;
  }
  return raw;
}

export function errorTextOf(step: ToolStep): string | undefined {
  if (step.status !== "error") return undefined;
  const raw = rawOf(step.output);
  if (raw === undefined) return "The call failed.";
  const parsed = jsonOf(step);
  if (typeof parsed === "object" && parsed !== null) {
    const said = (parsed as Record<string, unknown>).error;
    if (typeof said === "string" && said.trim() !== "") return said.trim();
  }
  return raw.split("\n")[0] ?? raw;
}

/** A raw input key in owner words: "profile_id" -> "Profile", "query" -> "Query". */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim();
  return words === "" ? key : words.charAt(0).toLocaleUpperCase("en") + words.slice(1);
}

/** Curated fields per tool: the rows that matter, in reading order, with
 * plain labels. Unlisted keys follow, label humanized. */
export const FIELDS: Record<string, readonly (readonly [string, string, boolean?])[]> = {
  schedule_set: [
    ["name", "Name"],
    ["schedule", "Schedule", true],
    ["once", "At", true],
    ["prompt", "Prompt"],
    ["trial", "Starts as a trial"],
  ],
  schedule_remove: [["name", "Name"]],
  sensor_set: [
    ["kind", "Kind"],
    ["url", "Source", true],
    ["name", "Name"],
  ],
  sensor_remove: [["name", "Name"]],
  webhook_create: [
    ["name", "Name"],
    ["description", "Description"],
  ],
  webhook_remove: [["name", "Name"]],
  task_message: [
    ["id", "Task", true],
    ["message", "Says"],
  ],
  task_status: [["id", "Task", true]],
  task_cancel: [["id", "Task", true]],
  notify_owner: [
    ["message", "Note"],
    ["text", "Note"],
  ],
  memory_forget: [
    ["query", "Search"],
    ["id", "Memory", true],
  ],
  memory_history: [
    ["query", "Search"],
    ["id", "Memory", true],
  ],
  memory_related: [
    ["query", "About"],
    ["about", "About"],
  ],
  history_search: [
    ["query", "Search"],
    ["bot", "In"],
  ],
  calendar_events: [
    ["days", "Window"],
    ["calendar", "Calendar"],
    ["query", "For"],
  ],
  skill_load: [["name", "Skill"]],
  skill_write: [
    ["name", "Skill"],
    ["description", "Does what"],
  ],
  skill_delete: [["name", "Skill"]],
  skill_learn: [
    ["name", "Skill"],
    ["lesson", "Learned"],
  ],
  skill_install: [
    ["url", "From", true],
    ["name", "As"],
  ],
  skill_propose: [
    ["name", "Skill"],
    ["note", "Change"],
  ],
  skill_evolve: [["name", "Skill"]],
  vault_contacts: [["query", "Looking for"]],
  bot_info: [
    ["bot", "Bot", true],
    ["name", "Bot", true],
    ["id", "Bot", true],
  ],
  connector_load: [
    ["connector", "Connector"],
    ["name", "Connector"],
  ],
  connector_remove: [["name", "Name"]],
  connector_reconnect: [["name", "Name"]],
  state_set: [
    ["key", "Note"],
    ["value", "Says"],
  ],
  state_get: [["key", "Note"]],
  state_delete: [["key", "Note"]],
  email_send: [
    ["to", "To"],
    ["subject", "Subject"],
  ],
  send_message: [["to", "To"]],
  secret_request: [
    ["service", "Service"],
    ["callId", "This ask", true],
  ],
};

/** A definition-list body from an input object: curated rows first, long text
 * as the note, every label in owner words. */
export function recordOfInput(
  input: Record<string, unknown>,
  skip: readonly string[] = [],
  tool?: string,
): { fields: RecordField[]; note?: string } {
  const curated = tool === undefined ? [] : (FIELDS[tool] ?? []);
  const seen = new Set<string>(skip);
  const fields: RecordField[] = [];
  let note: string | undefined;
  const rowOf = (key: string, label: string, mono: boolean | undefined, value: unknown): void => {
    if (typeof value === "string") {
      const flat = value.length > 160 ? undefined : value.replace(/\s+/g, " ").trim();
      if (flat === undefined) {
        note ??= value.trim();
        return;
      }
      if (flat === "") return;
      fields.push({ k: label, v: flat, ...(mono ? { mono } : {}) });
    } else if (typeof value === "number" || typeof value === "boolean") {
      fields.push({ k: label, v: String(value), ...(mono ? { mono } : {}) });
    }
  };
  for (const [key, label, mono] of curated) {
    if (!(key in input)) continue;
    seen.add(key);
    rowOf(key, label, mono, input[key]);
  }
  for (const [key, value] of Object.entries(input)) {
    if (seen.has(key)) continue;
    rowOf(key, humanizeKey(key), undefined, value);
  }
  return { fields, ...(note === undefined ? {} : { note }) };
}
