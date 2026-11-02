/**
 * Owner-facing words for the transcript's tool calls: what a call did, what
 * it is doing right now, and the one detail worth showing. The mind's tool
 * names and payloads stay untouched; this is a presentation lens (approval-text.ts
 * words the approval cards the same way).
 */
import {
  CHECKLIST_TOOL,
  GRAPH_TOOL,
  type ChecklistDetails,
  type ToolStep,
} from "@spriessen/contracts";
import { adminView } from "./admin-tool-views.ts";
import { plural } from "./plural.ts";
import { checklistView, graphView } from "./chat-tool-views.ts";
import { parseWrittenArtifact, type FileRef } from "./file-meta.ts";
import { learnedOf, type LearnedRef } from "./learned.ts";

export type ToolFamily =
  | "memory"
  | "social"
  | "web"
  | "task"
  | "routine"
  | "artifact"
  | "skill"
  | "code"
  | "credentials"
  | "connectors"
  | "generic";

/** Any tool name in owner words: "mcp__linear_create_issue" -> "Linear create issue". */
export function humanizeToolName(name: string): string {
  const cleaned = name
    .replace(/^mcp__?/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.:]+/g, " ")
    .trim();
  if (cleaned === "") return "Used a tool";
  return cleaned.charAt(0).toUpperCase("en") + cleaned.slice(1);
}

/** Tools that are inner monologue, not owner-facing work: render nothing. */
const HIDDEN = new Set(["jev", "jev_score", "jev_pick", "jev_rate", "now"]);

/** One web hit. */
export type SearchHit = {
  readonly title: string;
  readonly url: string;
  readonly site?: string | undefined;
  readonly snippet?: string | undefined;
  readonly date?: string | undefined;
};

/** One key-value row of a structured record (a created bot, a set schedule). */
export type RecordField = {
  readonly k: string;
  readonly v: string;
  /** Values that are code, paths or ids render in mono. */
  readonly mono?: boolean | undefined;
};

/** The expanded body of a tool call, already shaped for its kind. */
export type ToolBodyData =
  | { readonly t: "search"; readonly query: string; readonly hits: readonly SearchHit[] }
  | {
      readonly t: "http";
      readonly method: string;
      readonly url: string;
      readonly status?: number | undefined;
      readonly sent?: string | undefined;
      readonly got?: string | undefined;
    }
  | { readonly t: "term"; readonly command: string; readonly output: string }
  | { readonly t: "file"; readonly name: string; readonly text: string }
  | {
      readonly t: "record";
      readonly fields: readonly RecordField[];
      readonly note?: string | undefined;
    }
  | { readonly t: "page"; readonly url: string; readonly host: string; readonly text: string }
  | { readonly t: "output"; readonly text: string }
  | { readonly t: "json" };

/** Tools whose input adds nothing worth a row: their body is the output. */
const INPUTLESS = new Set([
  "bots_list",
  "vault_list",
  "connector_list",
  "skill_list",
  "task_list",
  "schedule_list",
  "sensor_list",
  "webhook_list",
  "state_list",
  "artifact_list",
]);

export type ToolView = {
  readonly family: ToolFamily;
  /** Past tense, for a finished call: "Searched the web". */
  readonly done: string;
  /** Present tense, while it runs: "Searching the web…". */
  readonly live: string;
  /** The one input-derived detail worth showing beside the title. */
  readonly detail?: string | undefined;
  /** The owner-facing body shown uncollapsed: a memory, a message. */
  readonly body?: string | undefined;
  /** Small captions under the body: basis, kind, topic. */
  readonly tags?: readonly string[] | undefined;
  /** Plain rows for list-shaped outputs (recalled facts, a room transcript). */
  readonly lines?: readonly string[] | undefined;
  /** Where a "look it up" affordance should land (the Memory panel). */
  readonly lookup?: string | undefined;
  /** A saved file to render as a card (artifact_write on success only). */
  readonly artifact?: FileRef | undefined;
  /** The expanded view's shaped body; absent means raw receipts. */
  readonly structured?: ToolBodyData | undefined;
  /** A skill this call learned on its own, for the one-tap undo (skill_learn). */
  readonly learned?: LearnedRef | undefined;
  /** The plan a checklist call settled on: drawn as the plan card. */
  readonly checklist?: ChecklistDetails | undefined;
  /** The Mermaid source a graph call drew, redrawn in the browser. */
  readonly diagram?: { readonly source: string; readonly title: string | null } | undefined;
};

export type ToolPresentation =
  | { readonly kind: "hidden" }
  | { readonly kind: "human"; readonly view: ToolView };

/* ---- small safe readers over the untyped JSON input ---- */

const recordOf = (input: unknown): Record<string, unknown> =>
  typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};

/** A field as one line: newlines and runs of space collapse. */
const flatOf = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const flat = value.replace(/\s+/g, " ").trim();
  return flat === "" ? undefined : flat;
};

/** A field kept as written (bodies, transcripts): trimmed only. */
const rawOf = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  return raw === "" ? undefined : raw;
};

const clip = (value: string | undefined, max: number): string | undefined => {
  if (value === undefined) return undefined;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

const hostOf = (url: string | undefined): string | undefined => {
  if (url === undefined) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return clip(url, 40);
  }
};

/** Resolves another bot's profile id to its name when the app knows it. */
export type NameOf = (profileId: string) => string | undefined;

/** The output as JSON when it parses; undefined otherwise. */
const jsonOf = (step: ToolStep): unknown => {
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
  return error !== undefined && raw === error ? undefined : raw;
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
function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim();
  return words === "" ? key : words.charAt(0).toUpperCase("en") + words.slice(1);
}

/** Curated fields per tool: the rows that matter, in reading order, with
 * plain labels. Unlisted keys follow, label humanized. */
const FIELDS: Record<string, readonly (readonly [string, string, boolean?])[]> = {
  schedule_set: [
    ["name", "Name"],
    ["schedule", "Schedule", true],
    ["once", "At", true],
    ["prompt", "Prompt"],
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
function recordOfInput(
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

/* ---- per-tool wordings ---- */

const BASIS_TAGS: Record<string, string> = {
  owner_said: "from you",
  observed: "observed",
  inferred: "inferred",
};

const MEMORY_WRITE_TITLES: Record<string, string> = {
  add: "Remembered",
  refine: "Updated a memory",
  supersede: "Corrected an older note",
  noop: "No change",
};

const writeView = (step: ToolStep): ToolView => {
  const input = recordOf(step.input);
  const output = rawOf(step.output) ?? "";
  const op = output.match(/^remembered \((\w+)/)?.[1];
  const refused = step.status === "error" || output.startsWith("refused");
  const text = rawOf(input.text) ?? output.replace(/^remembered \([^)]*\):\s*/, "");
  const kind = flatOf(input.kind);
  const basis = BASIS_TAGS[flatOf(input.basis) ?? ""] ?? "noted";
  return {
    family: "memory",
    done:
      op !== undefined && MEMORY_WRITE_TITLES[op] !== undefined
        ? MEMORY_WRITE_TITLES[op]
        : refused
          ? "Couldn't save that memory"
          : "Remembered",
    live: "Noting it down…",
    body: clip(text, 300),
    tags: [
      basis,
      ...(kind !== undefined && kind !== "note" ? [kind] : []),
      ...(input.scope === "owner" ? ["shared"] : []),
    ],
    lookup: text,
  };
};

const recallView = (step: ToolStep): ToolView => {
  const input = recordOf(step.input);
  const output = rawOf(step.output);
  const detail = clip(flatOf(input.about) ?? flatOf(input.query), 32);
  if (output === undefined || output === "no matching memory.") {
    return { family: "memory", done: "No memories matched", live: "Checking memory…", detail };
  }
  const lines = output.split("\n").filter((line) => line.trim() !== "");
  return {
    family: "memory",
    done: `Recalled ${lines.length} ${lines.length === 1 ? "memory" : "memories"}`,
    live: "Checking memory…",
    detail,
    lines,
  };
};

const coreView = (step: ToolStep): ToolView => {
  const input = recordOf(step.input);
  const listing = input.action === "list";
  return {
    family: "memory",
    done: listing ? "Read core memory" : "Updated core memory",
    live: listing ? "Reading core memory…" : "Updating core memory…",
    body: clip(rawOf(input.text), 200),
  };
};

const messageView = (step: ToolStep, nameOf: NameOf | undefined): ToolView => {
  const input = recordOf(step.input);
  const to = flatOf(input.to);
  const name = to === undefined ? "another bot" : (nameOf?.(to) ?? to);
  const topic = flatOf(input.topic);
  return {
    family: "social",
    done:
      step.status === "error"
        ? "Couldn't send that"
        : input.kind === "notify"
          ? `Notified ${name}`
          : `Asked ${name}`,
    live: "Sending a message…",
    body: clip(rawOf(input.body), 4000),
    tags: topic === undefined ? undefined : [`room: ${topic}`],
  };
};

const roomView = (step: ToolStep): ToolView => {
  const output = rawOf(step.output);
  const topic = output?.match(/Room “(.+?)”/)?.[1];
  // The transcript proper starts after the "Room … — full transcript:" header.
  const body = output?.slice(output.indexOf("\n\n") + 2);
  return {
    family: "social",
    done: "Read a room transcript",
    live: "Reading a room…",
    detail: clip(topic, 32),
    lines: body === undefined || body === "" ? undefined : body.split("\n\n---\n\n"),
  };
};

const searchView = (step: ToolStep): ToolView => {
  const query = clip(flatOf(recordOf(step.input).query), 60) ?? "";
  const parsed = jsonOf(step) as { results?: unknown } | undefined;
  const raw = Array.isArray(parsed?.results) ? (parsed?.results as readonly unknown[]) : [];
  const hits = raw
    .flatMap((hit): SearchHit[] => {
      const row = recordOf(hit);
      const title = flatOf(row.title);
      const url = flatOf(row.url);
      if (title === undefined || url === undefined) return [];
      return [
        {
          title,
          url,
          site: flatOf(row.site),
          snippet: clip(flatOf(row.snippet), 200),
          date: flatOf(row.date),
        },
      ];
    })
    .slice(0, 12);
  return {
    family: "web",
    done:
      hits.length > 0
        ? `Searched the web · ${hits.length} ${plural(hits.length, "hit", "hits")}`
        : "Searched the web",
    live: "Searching the web…",
    detail: clip(query, 40),
    ...(hits.length > 0 ? { structured: { t: "search", query, hits } } : {}),
  };
};

/** web_fetch takes `urls` (1-10); a lone `url` is read for older calls. */
const fetchUrlsOf = (input: unknown): string[] => {
  const record = recordOf(input);
  const many = Array.isArray(record.urls) ? record.urls.flatMap((u) => flatOf(u) ?? []) : [];
  const one = flatOf(record.url);
  return many.length > 0 ? many : one === undefined ? [] : [one];
};

const fetchView = (step: ToolStep): ToolView => {
  const urls = fetchUrlsOf(step.input);
  const url = urls[0];
  const host = hostOf(url) ?? "page";
  // The tool answers { pages: [{ url, content, ... }] }; `content` at the top is older.
  const parsed = recordOf(jsonOf(step));
  const pages = Array.isArray(parsed.pages) ? parsed.pages.map(recordOf) : [];
  const first = pages[0];
  const content =
    typeof first?.content === "string"
      ? first.content
      : typeof parsed.content === "string"
        ? parsed.content
        : undefined;
  const text =
    content !== undefined
      ? clip(content, 6000)
      : step.status === "error"
        ? undefined
        : clip(rawOf(step.output), 6000);
  const more = urls.length > 1 ? ` +${urls.length - 1}` : "";
  return {
    family: "web",
    done: urls.length > 1 ? `Read ${urls.length} web pages` : "Read a web page",
    live: urls.length > 1 ? "Reading web pages…" : "Reading a web page…",
    detail: `${host}${more}`,
    ...(url === undefined || text === undefined
      ? {}
      : { structured: { t: "page", url, host, text } }),
  };
};

const taskView = (step: ToolStep): ToolView => {
  const input = recordOf(step.input);
  const title = clip(flatOf(input.title) ?? flatOf(input.prompt), 40);
  return {
    family: "task",
    done: "Started a task",
    live: "Starting a task…",
    detail: title,
    structured: { t: "record", fields: [], note: clip(rawOf(input.prompt), 2000) },
  };
};

/** A saved file's ref: `details` when shaped right, else the legacy output line. */
const artifactFileOf = (step: ToolStep): FileRef | undefined => {
  if (step.status !== "done") return undefined;
  const details = recordOf(step.details);
  const id = flatOf(details.id);
  if (id === undefined || id === "")
    return parseWrittenArtifact(rawOf(step.output) ?? "") ?? undefined;
  const mime = flatOf(details.mime);
  return {
    id,
    name: flatOf(details.name) ?? flatOf(recordOf(step.input).name) ?? id,
    ...(mime === undefined ? {} : { mime }),
    ...(typeof details.bytes === "number" ? { bytes: details.bytes } : {}),
  };
};

const artifactView = (step: ToolStep, past: string, live: string): ToolView => {
  const input = recordOf(step.input);
  const file = step.name === "artifact_write" ? artifactFileOf(step) : undefined;
  const read = step.name === "artifact_read" ? rawOf(step.output) : undefined;
  // artifact_read takes only an id; its answer opens with "# <file name>".
  const heading = read?.match(/^# (.+)\n/)?.[1];
  const name = clip(flatOf(input.name) ?? flatOf(input.path) ?? flatOf(heading), 40);
  const listing = step.name === "artifact_list" ? rawOf(step.output) : undefined;
  return {
    family: "artifact",
    done: past,
    live,
    detail: name,
    ...(listing === undefined
      ? {}
      : { lines: listing.split("\n").filter((line) => line.trim() !== "") }),
    ...(read === undefined || name === undefined
      ? {}
      : {
          structured: {
            t: "file",
            name,
            text: clip(heading === undefined ? read : read.replace(/^# .+\n\n?/, ""), 8000) ?? read,
          },
        }),
    ...(file === undefined ? {} : { artifact: file }),
  };
};

/**
 * The read-only browser (phase 4 slice 9): the page text like a web read,
 * plus the screenshot as an image card (the same `details` ref shape
 * artifact_write carries, so the app draws it like any saved file).
 */
const browserView = (step: ToolStep): ToolView => {
  const input = recordOf(step.input);
  const url = flatOf(input.url);
  const host = hostOf(url) ?? "page";
  const parsed = recordOf(jsonOf(step));
  const text = typeof parsed.text === "string" ? clip(parsed.text, 6000) : undefined;
  const file = step.status === "done" ? artifactFileOf(step) : undefined;
  return {
    family: "web",
    done: "Opened a page in the sandbox browser",
    live: "Opening a page in the sandbox browser…",
    detail: host,
    ...(url === undefined || text === undefined
      ? {}
      : { structured: { t: "page", url, host, text } }),
    ...(file === undefined ? {} : { artifact: file }),
  };
};

/**
 * The script a shell call ran. `bash` takes it as `script`; `command` is
 * read too for older stored calls. Kept as written (newlines and all), so
 * the copy button copies a runnable script.
 */
const scriptOf = (input: unknown): string => {
  const record = recordOf(input);
  return rawOf(record.script) ?? rawOf(record.command) ?? "";
};

/** Where a bash call ran, in owner words ("in its workspace VM", "on the host", "on node x"). */
const bashWhere = (input: unknown): string => {
  const target = recordOf(input).target;
  if (target === "host") return "on the host";
  if (target === "node") {
    const node = rawOf(recordOf(input).node);
    return node === undefined ? "on its node" : `on node ${node}`;
  }
  return "in its workspace VM";
};

const bashView = (step: ToolStep): ToolView => {
  const script = scriptOf(step.input);
  const where = bashWhere(step.input);
  return {
    family: "code",
    done: `Ran a script ${where}`,
    live: `Running a script ${where}…`,
    detail: clip(flatOf(script), 44),
    structured: { t: "term", command: script, output: outputBesidesError(step) ?? "" },
  };
};

const requestView = (step: ToolStep): ToolView => {
  const input = recordOf(step.input);
  const url = flatOf(input.url) ?? "";
  const host = hostOf(url);
  const method = (flatOf(input.method) ?? "GET").toUpperCase("en");
  const parsed = jsonOf(step) as Record<string, unknown> | undefined;
  const status = typeof parsed?.status === "number" ? parsed.status : undefined;
  const got =
    typeof parsed?.body === "string" ? clip(parsed.body, 6000) : clip(rawOf(step.output), 6000);
  return {
    family: "credentials",
    done: host === undefined ? "Sent a web request" : `Called ${host}`,
    live: host === undefined ? "Sending a web request…" : `Calling ${host}…`,
    detail: method,
    ...(url === "" ? {} : { structured: { t: "http", method, url, status, got } }),
  };
};

/** The main bot creating a bot: the name is the one detail worth showing. */
const botCreateView = (step: ToolStep): ToolView => {
  const input = recordOf(step.input);
  const name = flatOf(input.name);
  const made = recordOfInput(input, ["name", "persona"]);
  const persona = clip(rawOf(input.persona), 200);
  const fields = [
    ...(name !== undefined ? [{ k: "name", v: name }] : []),
    ...made.fields.map((field) => ({
      ...field,
      mono: field.k === "effort" || field.k === "model",
    })),
    ...(persona !== undefined ? [{ k: "persona", v: persona }] : []),
  ];
  return {
    family: "social",
    done:
      step.status === "error"
        ? "Couldn't create the bot"
        : name === undefined
          ? "Created a bot"
          : `Created bot ${name}`,
    live: "Creating a bot…",
    detail: name,
    ...(step.status === "done" && fields.length > 0
      ? { structured: { t: "record", fields, note: clip(rawOf(step.output), 240) } }
      : {}),
  };
};

/** Simple verb tables: exact tool name → [past, live-ing, family]. */
const VERBED: Record<string, [string, string, ToolFamily]> = {
  memory_forget: ["Forgot a memory", "Forgetting a memory…", "memory"],
  memory_history: ["Traced a memory's history", "Tracing a memory…", "memory"],
  memory_related: ["Looked up related memories", "Looking up related memories…", "memory"],
  task_message: ["Steered a task", "Steering a task…", "task"],
  task_status: ["Checked a task", "Checking a task…", "task"],
  task_list: ["Listed tasks", "Listing tasks…", "task"],
  task_cancel: ["Cancelled a task", "Cancelling a task…", "task"],
  notify_owner: ["Sent you a note", "Writing you a note…", "task"],
  schedule_set: ["Set a schedule", "Setting a schedule…", "routine"],
  schedule_remove: ["Removed a schedule", "Removing a schedule…", "routine"],
  schedule_list: ["Listed schedules", "Listing schedules…", "routine"],
  sensor_set: ["Set a watch", "Setting a watch…", "routine"],
  sensor_remove: ["Removed a watch", "Removing a watch…", "routine"],
  sensor_list: ["Listed watches", "Listing watches…", "routine"],
  webhook_create: ["Created a webhook", "Creating a webhook…", "routine"],
  webhook_remove: ["Removed a webhook", "Removing a webhook…", "routine"],
  webhook_list: ["Listed webhooks", "Listing webhooks…", "routine"],
  artifact_read: ["Read a file", "Reading a file…", "artifact"],
  artifact_list: ["Listed files", "Listing files…", "artifact"],
  artifact_delete: ["Deleted a file", "Deleting a file…", "artifact"],
  file_read: ["Read a file", "Reading a file…", "artifact"],
  file_search: ["Searched its files", "Searching its files…", "artifact"],
  file_edit: ["Changed a file", "Changing a file…", "artifact"],
  file_delete: ["Deleted a file", "Deleting a file…", "artifact"],
  extract_document_text: ["Read a document", "Reading a document…", "artifact"],
  secret_request: ["Asked you for a key", "Asking you for a key…", "credentials"],
  ask_user_question: ["Asked you a question", "Waiting for your answer…", "generic"],
  connector_add: ["Added a connector", "Adding a connector…", "connectors"],
  connector_update: ["Changed a connector", "Changing a connector…", "connectors"],
  connector_remove: ["Removed a connector", "Removing a connector…", "connectors"],
  connector_enable: ["Switched a connector on", "Switching a connector on…", "connectors"],
  connector_disable: ["Switched a connector off", "Switching a connector off…", "connectors"],
  state_get: ["Read its working notes", "Reading its notes…", "generic"],
  state_set: ["Saved a note", "Saving a note…", "generic"],
  state_list: ["Listed its working notes", "Listing its notes…", "generic"],
  state_delete: ["Removed a working note", "Removing a note…", "generic"],
  skill_list: ["Listed its skills", "Listing its skills…", "skill"],
  skill_load: ["Loaded a skill", "Loading a skill…", "skill"],
  skill_write: ["Wrote a skill", "Writing a skill…", "skill"],
  skill_delete: ["Removed a skill", "Removing a skill…", "skill"],
  skill_install: ["Installed a skill", "Installing a skill…", "skill"],
  skill_propose: ["Proposed a skill improvement", "Proposing an improvement…", "skill"],
  skill_evolve: ["Started improving a skill", "Improving a skill…", "skill"],
  vault_list: ["Checked the vault", "Checking the vault…", "credentials"],
  vault_contacts: ["Looked up a contact", "Looking up a contact…", "credentials"],
  bots_list: ["Listed bots", "Listing bots…", "social"],
  bot_info: ["Read a bot's profile", "Reading a profile…", "social"],
  connector_list: ["Listed connectors", "Listing connectors…", "connectors"],
  connector_load: ["Loaded connector tools", "Loading connector tools…", "connectors"],
  connector_reconnect: ["Reconnected a connector", "Reconnecting a connector…", "connectors"],
  connector_resources: ["Listed connector resources", "Listing connector resources…", "connectors"],
  history_search: ["Searched past chats", "Searching past chats…", "memory"],
  calendar_events: ["Read the calendar", "Reading the calendar…", "routine"],
  email_send: ["Sent an email", "Sending an email…", "social"],
  send_message: ["Sent a message", "Sending a message…", "social"],
};

/** A skill's reference file read: the content, previewed like any file. */
const skillFileView = (step: ToolStep): ToolView => {
  const input = recordOf(step.input);
  const name = clip(flatOf(input.path) ?? flatOf(input.file) ?? flatOf(input.name), 48);
  const text = rawOf(step.output);
  return {
    family: "skill",
    done: "Read a skill file",
    live: "Reading a skill file…",
    detail: name,
    ...(name === undefined || text === undefined
      ? {}
      : { structured: { t: "file", name, text: clip(text, 8000) ?? text } }),
  };
};

/** A skill learned on its own: the lesson quoted, with the undo beside it. */
const learnView = (step: ToolStep): ToolView => {
  const input = recordOf(step.input);
  const learned = step.status === "done" ? learnedOf(step.details) : undefined;
  const lesson = flatOf(input.lesson);
  const skill = clip(flatOf(input.name), 40);
  if (learned === undefined) {
    return {
      family: "skill",
      done: step.status === "error" ? "Didn't learn a skill" : "Learned a skill",
      live: "Learning a skill…",
      detail: skill,
    };
  }
  return {
    family: "skill",
    done: "Learned a skill",
    live: "Learning a skill…",
    detail: learned.skill,
    body: `learned: ${learned.lesson || lesson || learned.skill}`,
    tags: [`version ${learned.version}`],
    learned,
  };
};

/** The owner-facing lens on one tool call. */
export function presentationOf(step: ToolStep, nameOf?: NameOf): ToolPresentation {
  if (HIDDEN.has(step.name)) return { kind: "hidden" };
  switch (step.name) {
    case "memory_write":
      return { kind: "human", view: writeView(step) };
    case "memory_recall":
      return { kind: "human", view: recallView(step) };
    case "memory_core":
      return { kind: "human", view: coreView(step) };
    case "message":
      return { kind: "human", view: messageView(step, nameOf) };
    case "room":
      return { kind: "human", view: roomView(step) };
    case "web_search":
      return { kind: "human", view: searchView(step) };
    case "web_fetch":
    case "fetch":
      return { kind: "human", view: fetchView(step) };
    case "skill_file":
      return { kind: "human", view: skillFileView(step) };
    case "skill_learn":
      return { kind: "human", view: learnView(step) };
    case "task_spawn":
      return { kind: "human", view: taskView(step) };
    case "bash":
      return { kind: "human", view: bashView(step) };
    case "http_request":
      return { kind: "human", view: requestView(step) };
    case "artifact_write":
      return { kind: "human", view: artifactView(step, "Saved a file", "Saving a file…") };
    case "artifact_read":
      return { kind: "human", view: artifactView(step, "Read a file", "Reading a file…") };
    case "browser_open":
      return { kind: "human", view: browserView(step) };
    case "bot_create":
      return { kind: "human", view: botCreateView(step) };
    case CHECKLIST_TOOL:
      return { kind: "human", view: checklistView(step) };
    case GRAPH_TOOL:
      return { kind: "human", view: graphView(step) };
    default: {
      const admin = adminView(step);
      if (admin !== null) return { kind: "human", view: admin };
      const verbed = VERBED[step.name];
      if (verbed !== undefined) {
        const output = rawOf(step.output);
        if (INPUTLESS.has(step.name)) {
          return {
            kind: "human",
            view: {
              family: verbed[2],
              done: verbed[0],
              live: verbed[1],
              ...(output !== undefined
                ? { structured: { t: "output", text: clip(output, 8000) ?? output } }
                : {}),
            },
          };
        }
        const made = recordOfInput(recordOf(step.input), ["conversationId"], step.name);
        const lead = made.fields.find((field) => field.v !== "true" && field.v !== "false");
        return {
          kind: "human",
          view: {
            family: verbed[2],
            done: verbed[0],
            live: verbed[1],
            ...(lead !== undefined ? { detail: clip(lead.v, 36) } : {}),
            ...(made.fields.length > 0 || made.note !== undefined
              ? { structured: { t: "record", ...made } }
              : {}),
          },
        };
      }
      const humanized = humanizeToolName(step.name);
      return {
        kind: "human",
        view: { family: "generic", done: humanized, live: `${humanized}…` },
      };
    }
  }
}

/** Milliseconds in owner units: "740 ms", "2.3 s", "12 s", "1 m 04 s". */
export function humanizeMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) {
    const seconds = ms / 1000;
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} m ${String(seconds).padStart(2, "0")} s`;
}

/** Durations under this stay off the line entirely. */
export const DURATION_FLOOR_MS = 3000;
