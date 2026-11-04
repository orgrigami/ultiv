/**
 * The per-tool views of the presentation lens (tool-text.ts presentationOf):
 * memory, messages, rooms, search, fetch, tasks, files, browser, bash,
 * requests, bot creation, skills — each shapes one family's title, body and
 * receipts.
 */

import type { ToolStep } from "@spriessen/contracts";
import { plural } from "./plural.ts";
import { parseWrittenArtifact, type FileRef } from "./file-meta.ts";
import { learnedOf } from "./learned.ts";

import {
  clip,
  flatOf,
  hostOf,
  jsonOf,
  outputBesidesError,
  rawOf,
  recordOf,
  recordOfInput,
} from "./tool-values.ts";
export { errorTextOf, outputBesidesError } from "./tool-values.ts";

import type { NameOf, SearchHit, ToolView } from "./tool-text.ts";

export const BASIS_TAGS: Record<string, string> = {
  owner_said: "from you",
  observed: "observed",
  inferred: "inferred",
};

export const MEMORY_WRITE_TITLES: Record<string, string> = {
  add: "Remembered",
  refine: "Updated a memory",
  supersede: "Corrected an older note",
  noop: "No change",
};

export const writeView = (step: ToolStep): ToolView => {
  const input = recordOf(step.input);
  const output = rawOf(step.output) ?? "";
  // "remembered #1a2b3c4d (supersede, replaced #…): text" — the handle is the model's.
  const op = output.match(/^remembered (?:#\w+ )?\((\w+)/)?.[1];
  const refused = step.status === "error" || output.startsWith("refused");
  const text = rawOf(input.text) ?? output.replace(/^remembered (?:#\w+ )?\([^)]*\):\s*/, "");
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

export const recallView = (step: ToolStep): ToolView => {
  const input = recordOf(step.input);
  const output = rawOf(step.output);
  const detail = clip(flatOf(input.about) ?? flatOf(input.query), 32);
  if (output === undefined || output === "no matching memory.") {
    return { family: "memory", done: "No memories matched", live: "Checking memory…", detail };
  }
  // Each line leads with the fact's #handle: the model's address, not the owner's.
  const lines = output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.replace(/^#[0-9a-f]{6,}\s+/i, ""));
  return {
    family: "memory",
    done: `Recalled ${lines.length} ${lines.length === 1 ? "memory" : "memories"}`,
    live: "Checking memory…",
    detail,
    lines,
  };
};

const UPDATE_TITLES: Record<string, [string, string]> = {
  change: ["Updated a memory", "Updating a memory…"],
  correct: ["Corrected a memory", "Correcting a memory…"],
  end: ["Marked a memory as no longer true", "Retiring a memory…"],
  confirm: ["Confirmed a memory", "Confirming a memory…"],
};

/** memory_update: change / correct / end / confirm a fact by its handle. */
export const updateView = (step: ToolStep): ToolView => {
  const input = recordOf(step.input);
  const [done, live] = UPDATE_TITLES[flatOf(input.op) ?? ""] ?? [
    "Updated a memory",
    "Updating a memory…",
  ];
  const output = rawOf(step.output) ?? "";
  const refused = step.status === "error" || output.startsWith("refused");
  return {
    family: "memory",
    done: refused ? "Couldn't update that memory" : done,
    live,
    body: clip(
      rawOf(input.text) ?? (refused ? output.replace(/^refused:\s*/, "") : undefined),
      300,
    ),
  };
};

export const coreView = (step: ToolStep): ToolView => {
  const input = recordOf(step.input);
  const listing = input.action === "list";
  return {
    family: "memory",
    done: listing ? "Read core memory" : "Updated core memory",
    live: listing ? "Reading core memory…" : "Updating core memory…",
    body: clip(rawOf(input.text), 200),
  };
};

export const messageView = (step: ToolStep, nameOf: NameOf | undefined): ToolView => {
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

export const roomView = (step: ToolStep): ToolView => {
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

export const searchView = (step: ToolStep): ToolView => {
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
export const fetchUrlsOf = (input: unknown): string[] => {
  const record = recordOf(input);
  const many = Array.isArray(record.urls) ? record.urls.flatMap((u) => flatOf(u) ?? []) : [];
  const one = flatOf(record.url);
  return many.length > 0 ? many : one === undefined ? [] : [one];
};

export const fetchView = (step: ToolStep): ToolView => {
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

export const taskView = (step: ToolStep): ToolView => {
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
export const artifactFileOf = (step: ToolStep): FileRef | undefined => {
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

export const artifactView = (step: ToolStep, past: string, live: string): ToolView => {
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
export const browserView = (step: ToolStep): ToolView => {
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
export const scriptOf = (input: unknown): string => {
  const record = recordOf(input);
  return rawOf(record.script) ?? rawOf(record.command) ?? "";
};

/** Where a bash call ran, in owner words ("in its workspace VM", "on the host", "on node x"). */
export const bashWhere = (input: unknown): string => {
  const target = recordOf(input).target;
  if (target === "host") return "on the host";
  if (target === "node") {
    const node = rawOf(recordOf(input).node);
    return node === undefined ? "on its node" : `on node ${node}`;
  }
  return "in its workspace VM";
};

export const bashView = (step: ToolStep): ToolView => {
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

export const requestView = (step: ToolStep): ToolView => {
  const input = recordOf(step.input);
  const url = flatOf(input.url) ?? "";
  const host = hostOf(url);
  const method = (flatOf(input.method) ?? "GET").toLocaleUpperCase("en");
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
export const botCreateView = (step: ToolStep): ToolView => {
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

/** A skill's reference file read: the content, previewed like any file. */
export const skillFileView = (step: ToolStep): ToolView => {
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
export const learnView = (step: ToolStep): ToolView => {
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
