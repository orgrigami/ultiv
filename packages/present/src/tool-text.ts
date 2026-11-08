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
import { projectView } from "./project-tool-views.ts";
import { codeView } from "./code-tool-views.ts";
import { checklistView, graphView } from "./chat-tool-views.ts";
import type { FileRef } from "./file-meta.ts";
import type { LearnedRef } from "./learned.ts";

import { clip, rawOf, recordOf, recordOfInput } from "./tool-values.ts";
export { errorTextOf, outputBesidesError } from "./tool-values.ts";

import {
  artifactView,
  bashView,
  botCreateView,
  browserView,
  coreView,
  fetchView,
  learnView,
  messageView,
  recallView,
  updateView,
  requestView,
  roomView,
  searchView,
  skillFileView,
  taskMessageView,
  taskView,
  writeView,
} from "./tool-kind-views.ts";

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
  return cleaned.charAt(0).toLocaleUpperCase("en") + cleaned.slice(1);
}

/** Tools that are inner monologue, not owner-facing work: render nothing. */
const HIDDEN = new Set(["jev", "jev_score", "jev_pick", "jev_rate", "now"]);

/**
 * A reaction shows as the chip on the owner's message, not as a trace row;
 * only a refused one shows here, so a failure is never an empty bot turn.
 */
const isShownAsChip = (step: ToolStep): boolean => step.name === "react" && step.status !== "error";

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
  /** The background task this call started or messaged: drawn as its live line. */
  readonly task?: { readonly id: string } | undefined;
};

export type ToolPresentation =
  | { readonly kind: "hidden" }
  | { readonly kind: "human"; readonly view: ToolView };

/* ---- small safe readers over the untyped JSON input ---- */

/** Resolves another bot's profile id to its name when the app knows it. */
export type NameOf = (profileId: string) => string | undefined;

/* ---- per-tool wordings ---- */

/** Simple verb tables: exact tool name → [past, live-ing, family]. */
const VERBED: Record<string, [string, string, ToolFamily]> = {
  memory_forget: ["Forgot a memory", "Forgetting a memory…", "memory"],
  memory_history: ["Traced a memory's history", "Tracing a memory…", "memory"],
  memory_related: ["Looked up related memories", "Looking up related memories…", "memory"],
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
  table: ["Worked on a table", "Working on a table…", "generic"],
  browser_session: ["Used its browser session", "Using its browser session…", "web"],
  skill_list: ["Listed its skills", "Listing its skills…", "skill"],
  skill_load: ["Loaded a skill", "Loading a skill…", "skill"],
  skill_write: ["Wrote a skill", "Writing a skill…", "skill"],
  skill_edit: ["Edited several skills in one batch", "Applying a skill batch…", "skill"],
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
  react: ["Reacted to your message", "Reacting…", "social"],
};

/** The owner-facing lens on one tool call. */
export function presentationOf(step: ToolStep, nameOf?: NameOf): ToolPresentation {
  if (HIDDEN.has(step.name) || isShownAsChip(step)) return { kind: "hidden" };
  switch (step.name) {
    case "memory_write":
      return { kind: "human", view: writeView(step) };
    case "memory_recall":
      return { kind: "human", view: recallView(step) };
    case "memory_update":
      return { kind: "human", view: updateView(step) };
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
    case "task_message":
      return { kind: "human", view: taskMessageView(step) };
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
      const code = codeView(step);
      if (code !== null) return { kind: "human", view: code };
      const project = projectView(step);
      if (project !== null) return { kind: "human", view: project };
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
