/**
 * The main bot's admin calls in owner words: departments (list, create,
 * update, delete) and bots (details, update, move, pause, delete). Each one
 * reads as a small record card: who or what changed, and how. The argument
 * names come from the tools in `@spriessen/mind` (admin/).
 */
import type { ToolStep } from "@spriessen/contracts";
import type { RecordField, ToolView } from "./tool-text.ts";

type Words = readonly [done: string, live: string, failed: string];

const WORDS: Record<string, Words> = {
  departments_list: ["Read the departments", "Reading the departments…", "Couldn't read them"],
  department_create: ["Created a department", "Creating a department…", "Didn't create it"],
  department_update: ["Changed a department", "Changing a department…", "Didn't change it"],
  department_delete: ["Removed a department", "Removing a department…", "Didn't remove it"],
  bot_details: ["Read a bot's settings", "Reading a bot's settings…", "Couldn't read them"],
  bot_update: ["Changed a bot", "Changing a bot…", "Didn't change the bot"],
  bot_move: ["Moved a bot", "Moving a bot…", "Didn't move the bot"],
  bot_pause: ["Paused a bot", "Pausing a bot…", "Didn't pause the bot"],
  bot_delete: ["Removed a bot", "Removing a bot…", "Didn't remove the bot"],
};

/** The owner-facing label per argument, in the order shown. */
const LABELS: readonly (readonly [key: string, label: string])[] = [
  ["bot", "Bot"],
  ["department", "Department"],
  ["name", "Name"],
  ["role", "Role"],
  ["to", "To"],
  ["model", "Model"],
  ["effort", "Effort"],
  ["tools", "Tools"],
  ["cpus", "CPUs"],
  ["memoryMiB", "Memory (MiB)"],
  ["instructions", "Instructions"],
  ["persona", "Personality"],
];

const MONO = new Set(["model", "effort", "cpus", "memoryMiB"]);

export const isAdminTool = (name: string): boolean => name in WORDS;

const recordOf = (input: unknown): Record<string, unknown> =>
  typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};

const textOf = (value: unknown): string | undefined => {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string").join(", ");
  if (typeof value !== "string") return undefined;
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat === "") return undefined;
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
};

/** The call's arguments as rows, labelled and in a fixed order. */
export const adminFields = (input: unknown): RecordField[] => {
  const record = recordOf(input);
  const fields: RecordField[] = [];
  for (const [key, label] of LABELS) {
    const value = key === "to" && record[key] === "org" ? "the org" : textOf(record[key]);
    if (value !== undefined)
      fields.push({ k: label, v: value, ...(MONO.has(key) ? { mono: true } : {}) });
  }
  return fields;
};

/** The one detail beside the title: "Ada → Research", or the bot or department. */
const detailOf = (input: Record<string, unknown>): string | undefined => {
  const who = textOf(input["bot"]) ?? textOf(input["department"]) ?? textOf(input["name"]);
  const to = textOf(input["to"]);
  if (who !== undefined && to !== undefined) return `${who} → ${to === "org" ? "the org" : to}`;
  return who;
};

const outputOf = (output: unknown): string | undefined =>
  typeof output === "string" && output.trim() !== "" ? output.trim().slice(0, 8000) : undefined;

/** The owner's lens on one admin call, or null when it isn't one. */
export function adminView(step: ToolStep): ToolView | null {
  const words = WORDS[step.name];
  if (words === undefined) return null;
  const input = recordOf(step.input);
  const resumed = step.name === "bot_pause" && input["paused"] === false;
  const [done, live, failed] = resumed
    ? (["Resumed a bot", "Resuming a bot…", "Didn't resume the bot"] as const)
    : words;
  const fields = adminFields(input);
  const output = outputOf(step.output);
  const detail = detailOf(input);
  return {
    family: "social",
    done: step.status === "error" ? failed : done,
    live,
    ...(detail !== undefined ? { detail } : {}),
    ...(fields.length > 0
      ? { structured: { t: "record", fields, ...(output !== undefined ? { note: output } : {}) } }
      : output !== undefined
        ? { structured: { t: "output", text: output } }
        : {}),
  };
}

/** The approval card's words for the admin calls that ask first. */
export const ADMIN_APPROVALS: Record<string, { action: string; risk: string; risky?: boolean }> = {
  department_update: {
    action: "change a department",
    risk: "Lower risk: its name, Instructions or VM size change for every bot in it.",
  },
  department_delete: {
    action: "remove a department",
    risk: "Higher risk: the department, its Instructions and shared memory go. Its bots must be moved out first.",
    risky: true,
  },
  bot_update: {
    action: "change a bot",
    risk: "Lower risk: its name, role, Instructions, model or tools change. Its access switches stay yours.",
  },
  bot_delete: {
    action: "remove a bot",
    risk: "Higher risk: the bot, its memory and its chats are deleted for good.",
    risky: true,
  },
};
