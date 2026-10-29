/**
 * Owner-facing words for the transcript's tool calls: what a call did, what
 * it is doing right now, and the one detail worth showing. The mind's tool
 * names and payloads stay untouched; this is a presentation lens (the sibling
 * of approval-text.ts, which words the approval cards the same way).
 */
import type { ToolStep } from "@ultiv/contracts";

export type ToolFamily =
  | "memory"
  | "social"
  | "web"
  | "task"
  | "routine"
  | "artifact"
  | "code"
  | "credentials"
  | "connectors"
  | "generic";

/** Tools that are inner monologue, not owner-facing work: render nothing. */
const HIDDEN = new Set(["jev", "jev_score", "jev_pick", "jev_rate", "now"]);

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
};

export type ToolPresentation =
  | { readonly kind: "hidden" }
  | { readonly kind: "classic" }
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

/** Resolves a sibling profile id to its name when the app knows it. */
export type NameOf = (profileId: string) => string | undefined;

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
  noop: "Already knew this",
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
  const name = to === undefined ? "a sibling bot" : (nameOf?.(to) ?? to);
  const topic = flatOf(input.topic);
  return {
    family: "social",
    done:
      step.status === "error"
        ? "Couldn't send that"
        : input.kind === "notify"
          ? `Notified ${name}`
          : `Asked ${name}`,
    live: "Writing to a sibling…",
    body: clip(rawOf(input.body), 400),
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

const searchView = (step: ToolStep): ToolView => ({
  family: "web",
  done: "Searched the web",
  live: "Searching the web…",
  detail: clip(flatOf(recordOf(step.input).query), 40),
});

const fetchView = (step: ToolStep): ToolView => ({
  family: "web",
  done: "Read a web page",
  live: "Reading a web page…",
  detail: hostOf(flatOf(recordOf(step.input).url)),
});

const taskView = (step: ToolStep): ToolView => {
  const input = recordOf(step.input);
  return {
    family: "task",
    done: "Started a task",
    live: "Starting a task…",
    detail: clip(flatOf(input.title) ?? flatOf(input.prompt), 40),
    body: clip(rawOf(input.prompt), 300),
  };
};

const artifactView = (step: ToolStep, past: string, live: string): ToolView => {
  const input = recordOf(step.input);
  return {
    family: "artifact",
    done: past,
    live,
    detail: clip(flatOf(input.name) ?? flatOf(input.path), 40),
  };
};

const bashView = (step: ToolStep): ToolView => {
  const command = flatOf(recordOf(step.input).command);
  return {
    family: "code",
    done: "Ran a script",
    live: "Running a script…",
    detail: clip(command, 44),
  };
};

const requestView = (step: ToolStep): ToolView => {
  const input = recordOf(step.input);
  const host = hostOf(flatOf(input.url));
  return {
    family: "credentials",
    done: host === undefined ? "Sent a web request" : `Called ${host}`,
    live: host === undefined ? "Sending a web request…" : `Calling ${host}…`,
    detail: flatOf(input.method),
  };
};

/** Simple verb tables: exact tool name → [past, live-ing, family]. */
const VERBED: Record<string, [string, string, ToolFamily]> = {
  memory_forget: ["Let a memory go", "Letting a memory go…", "memory"],
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
  secret_request: ["Asked you for a key", "Asking you for a key…", "credentials"],
  connector_add: ["Added a connector", "Adding a connector…", "connectors"],
  connector_update: ["Changed a connector", "Changing a connector…", "connectors"],
  connector_remove: ["Removed a connector", "Removing a connector…", "connectors"],
  connector_enable: ["Switched a connector on", "Switching a connector on…", "connectors"],
  connector_disable: ["Switched a connector off", "Switching a connector off…", "connectors"],
  state_get: ["Read its working notes", "Reading its notes…", "generic"],
  state_set: ["Jotted a working note", "Jotting a note…", "generic"],
  state_list: ["Listed its working notes", "Listing its notes…", "generic"],
  state_delete: ["Removed a working note", "Removing a note…", "generic"],
  bash_host: ["Ran a script on the host", "Running a host script…", "code"],
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
      return { kind: "human", view: fetchView(step) };
    case "task_spawn":
      return { kind: "human", view: taskView(step) };
    case "bash":
      return { kind: "human", view: bashView(step) };
    case "http_request":
      return { kind: "human", view: requestView(step) };
    case "artifact_write":
      return { kind: "human", view: artifactView(step, "Saved a file", "Saving a file…") };
    default: {
      const verbed = VERBED[step.name];
      if (verbed !== undefined) {
        return {
          kind: "human",
          view: { family: verbed[2], done: verbed[0], live: verbed[1] },
        };
      }
      return { kind: "classic" };
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
