/**
 * The task sheet's timeline in plain words: each raw activity step becomes a
 * friendly line ("Checked the time", "Read plato.stanford.edu · Aristotle on
 * Causality", "Searched the web for …") with the raw call pretty-printed for
 * an optional peek. Pure, so it is unit-tested; unknown tools fall back to a
 * humanized name and malformed output never throws.
 */
import type { TaskActivity } from "@/lib/api";
import type { ToolStep as ToolStepContract } from "@ultiv/contracts";

export type ActivityStep = TaskActivity["steps"][number];

export type ToolIcon =
  | "clock"
  | "search"
  | "page"
  | "file"
  | "memory"
  | "terminal"
  | "message"
  | "task"
  | "plug"
  | "key"
  | "tool";

export type TimelineItem =
  | {
      kind: "tool";
      key: string;
      icon: ToolIcon;
      line: string;
      name: string;
      status: "running" | "done" | "error";
      durationMs: number | null;
      input: string | null;
      output: string | null;
      inputRaw: unknown;
      outputRaw: unknown;
    }
  | { kind: "thinking"; key: string; text: string }
  | { kind: "message"; key: string; text: string }
  | { kind: "note"; key: string; text: string }
  | { kind: "input"; key: string; text: string };

const LINE_CHARS = 80;
const clip = (text: string, max = LINE_CHARS): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/** "web_fetch" -> "Web fetch"; "docs_search_pages" -> "Docs search pages". */
export function humanizeToolName(name: string): string {
  const words = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-.:]+/g, " ")
    .trim()
    .toLowerCase();
  if (words === "") return "Used a tool";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** JSON text -> value; anything else stays as it was. */
export function parseLoose(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** "https://www.example.com/a" -> "example.com"; junk -> the input, clipped. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return clip(url, 40);
  }
}

/** A fetched page's title: its own title field, else the first markdown heading. */
function pageTitle(page: Record<string, unknown>): string | undefined {
  const own = str(page["title"]);
  if (own !== undefined) return own;
  const content = str(page["content"]);
  return content?.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim();
}

function readLine(input: unknown, output: unknown): string {
  const urls = record(input)["urls"];
  const first = Array.isArray(urls) ? str(urls[0]) : str(record(input)["url"]);
  const pages = record(output)["pages"];
  const page = record(Array.isArray(pages) ? pages[0] : undefined);
  const url = first ?? str(page["url"]);
  if (url === undefined) return "Read a web page";
  const title = pageTitle(page);
  const more = Array.isArray(urls) && urls.length > 1 ? ` +${urls.length - 1} more` : "";
  return clip(`Read ${hostOf(url)}${title !== undefined ? ` · ${title}` : ""}${more}`);
}

type Describe = (input: Record<string, unknown>, output: unknown) => string;

const quoted = (prefix: string, value: unknown, fallback: string): string => {
  const text = str(value);
  return text === undefined ? fallback : clip(`${prefix} “${clip(text, 50)}”`);
};

/** Known tools -> [icon, describe]. Everything else is humanized. */
const KNOWN: Record<string, readonly [ToolIcon, Describe]> = {
  now: ["clock", () => "Checked the time"],
  web_search: ["search", (i) => quoted("Searched the web for", i["query"], "Searched the web")],
  web_fetch: ["page", (i, o) => readLine(i, o)],
  fetch: ["page", (i, o) => readLine(i, o)],
  http_request: [
    "page",
    (i) => {
      const url = str(i["url"]);
      const method = str(i["method"])?.toUpperCase() ?? "GET";
      return url === undefined ? "Called a web service" : clip(`${method} ${hostOf(url)}`);
    },
  ],
  history_search: [
    "search",
    (i) => quoted("Searched past chats for", i["query"], "Searched past chats"),
  ],
  memory_recall: [
    "memory",
    (i) => quoted("Looked in memory for", i["query"], "Looked through memory"),
  ],
  memory_write: ["memory", () => "Saved something to memory"],
  artifact_write: ["file", (i) => quoted("Saved the file", i["name"], "Saved a file")],
  artifact_read: ["file", () => "Opened a saved file"],
  artifact_list: ["file", () => "Listed saved files"],
  bash: [
    "terminal",
    (i) => {
      const first = str(i["script"])?.split("\n")[0];
      return first === undefined ? "Ran a command" : clip(`Ran ${first}`);
    },
  ],
  notify_owner: ["message", () => "Sent you an update"],
  send_message: ["message", () => "Sent a message"],
  email_send: ["message", () => "Sent an email"],
  task_spawn: ["task", () => "Started another task"],
  task_status: ["task", () => "Checked on a task"],
  connector_load: ["plug", () => "Loaded connector tools"],
  vault_list: ["key", () => "Checked saved logins"],
};

export function toolLine(
  name: string,
  input: unknown,
  output: unknown,
): { icon: ToolIcon; line: string } {
  const known = KNOWN[name];
  const args = record(parseLoose(input));
  const result = parseLoose(output);
  if (known !== undefined) {
    try {
      return { icon: known[0], line: known[1](args, result) };
    } catch {
      return { icon: known[0], line: humanizeToolName(name) };
    }
  }
  return { icon: "tool", line: `Used ${humanizeToolName(name).toLowerCase()}` };
}

/** Pretty JSON when it parses, the text as-is otherwise; null for nothing. */
export function prettyPayload(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const parsed = parseLoose(value);
  if (typeof parsed === "string") return parsed.trim() === "" ? null : parsed;
  try {
    const text = JSON.stringify(parsed, null, 2);
    return text === "{}" || text === "[]" ? null : text;
  } catch {
    return String(value);
  }
}

/** "12ms" -> "<1s", 4210 -> "4s", 95000 -> "1m 35s". */
export function formatDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return "<1s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

const UPDATE_PREFIX = /^\[task [^\]]*update\]\s*/;
const same = (a: string, b: string): boolean => {
  const x = a.trim();
  const y = b.trim();
  return x !== "" && (y.startsWith(x.replace(/…$/, "")) || x.startsWith(y));
};

/** Raw steps -> timeline. The brief and the final result have their own rows, so they are dropped here. */
export function timelineOf(
  steps: readonly ActivityStep[],
  brief: string,
  result: string | null,
): TimelineItem[] {
  const items: TimelineItem[] = [];
  steps.forEach((step, index) => {
    const key = `${step.at}-${index}`;
    const text = typeof step.text === "string" ? step.text : "";
    if (step.kind === "tool") items.push(toolItem(step, key, text));
    else if (step.kind === "thinking") {
      if (text.trim() !== "") items.push({ kind: "thinking", key, text });
    } else if (step.kind === "input") {
      if (!same(text, brief)) items.push({ kind: "input", key, text });
    } else if (step.kind === "output") {
      const isResult = result !== null && index === steps.length - 1 && same(text, result);
      if (!isResult && text.trim() !== "") items.push({ kind: "message", key, text });
    } else if (text.trim() !== "") {
      items.push({ kind: "note", key, text: text.replace(UPDATE_PREFIX, "") });
    }
  });
  return items;
}

function toolItem(step: ActivityStep, key: string, text: string): TimelineItem {
  const tool = step.tool;
  // Older servers only send "name → output"; read the name back out of it.
  const name = tool?.name ?? text.split(/\s+(?:→|…)/)[0]?.trim() ?? "";
  const legacyOutput = tool === undefined ? (text.split(" → ")[1] ?? null) : null;
  const output = tool?.output ?? legacyOutput;
  const { icon, line } = toolLine(name, tool?.input, output);
  return {
    kind: "tool",
    key,
    icon,
    line,
    name,
    status: tool?.status ?? (text.endsWith(" …") ? "running" : "done"),
    durationMs: tool?.durationMs ?? null,
    input: prettyPayload(tool?.input),
    output: prettyPayload(output),
    inputRaw: tool?.input ?? null,
    outputRaw: output ?? null,
  };
}

/** A timeline tool row as the transcript's ToolStep, so both surfaces share
 * one presentation lens. */
export function toolStepOf(item: Extract<TimelineItem, { kind: "tool" }>): ToolStepContract {
  return {
    callId: item.key,
    name: item.name,
    status: item.status,
    input: parseLoose(item.inputRaw),
    output:
      typeof item.outputRaw === "string"
        ? item.outputRaw
        : item.outputRaw === null || item.outputRaw === undefined
          ? null
          : JSON.stringify(item.outputRaw, null, 2),
    durationMs: item.durationMs,
  };
}

/** The first `max` characters of a long payload, and whether there is more. */
export function previewOf(text: string, max: number): { text: string; more: boolean } {
  return text.length > max
    ? { text: `${text.slice(0, max).trimEnd()}…`, more: true }
    : { text, more: false };
}
