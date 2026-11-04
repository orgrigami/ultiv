/**
 * The checklist and graph calls in owner words. A checklist call becomes the
 * plan card (the list the tool returned in `details`); a graph call becomes
 * the diagram, drawn again in the browser from the `source` it was given.
 * The argument names come from the tools' schemas in `@spriessen/contracts`.
 */
import {
  CHECKLIST_TOOL,
  type ChecklistDetails,
  type ChecklistItem,
  type ChecklistParams,
  type GraphParams,
  type ToolStep,
} from "@spriessen/contracts";
import type { ToolView } from "./tool-text.ts";

const STATUSES = new Set(["pending", "in_progress", "done"]);

const itemOf = (value: unknown): ChecklistItem | null => {
  if (typeof value !== "object" || value === null) return null;
  const { text, status } = value as Record<string, unknown>;
  if (typeof text !== "string" || typeof status !== "string" || !STATUSES.has(status)) return null;
  return { text, status: status as ChecklistItem["status"] };
};

/** The list a checklist call settled on, when its details are shaped right. */
export function checklistOf(details: unknown): ChecklistDetails | null {
  if (typeof details !== "object" || details === null) return null;
  const { listId, title, items } = details as Record<string, unknown>;
  if (typeof listId !== "string" || !Array.isArray(items) || items.length === 0) return null;
  const parsed = items.map(itemOf);
  if (parsed.some((item) => item === null)) return null;
  return {
    listId,
    title: typeof title === "string" && title.trim() !== "" ? title : null,
    items: parsed as ChecklistItem[],
  };
}

export function checklistView(step: ToolStep): ToolView {
  const list = step.status === "done" ? checklistOf(step.details) : null;
  const input = (step.input ?? {}) as Partial<Record<keyof ChecklistParams, unknown>>;
  const replacing = Array.isArray(input.items);
  return {
    family: "task",
    done: step.status === "error" ? "Plan not changed" : "Updated the plan",
    live: replacing ? "Making a plan…" : "Updating the plan…",
    ...(list !== null ? { checklist: list } : {}),
  };
}

const textOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

export function graphView(step: ToolStep): ToolView {
  const input = (step.input ?? {}) as Partial<Record<keyof GraphParams, unknown>>;
  const source = textOf(input.source);
  const title = textOf(input.title)?.trim();
  const drew = step.status === "done" && source !== undefined;
  return {
    family: "artifact",
    done: step.status === "error" ? "Diagram not drawn" : "Drew a diagram",
    live: "Drawing a diagram…",
    ...(title !== undefined ? { detail: title } : {}),
    ...(drew ? { diagram: { source, title: title ?? null } } : {}),
  };
}

/**
 * The transcript with each plan shown once: a settled checklist call whose
 * list a later call updated is dropped, so the card sits at its latest update
 * and changes in place. Running and failed calls stay as their own lines.
 */
export function latestPlans<T extends { kind: string; step?: ToolStep }>(transcript: T[]): T[] {
  const listOf = (entry: T): string | undefined =>
    entry.kind === "tool" && entry.step?.name === CHECKLIST_TOOL && entry.step.status === "done"
      ? (checklistOf(entry.step.details)?.listId ?? undefined)
      : undefined;
  const last = new Map<string, number>();
  transcript.forEach((entry, index) => {
    const id = listOf(entry);
    if (id !== undefined) last.set(id, index);
  });
  if (last.size === 0) return transcript;
  return transcript.filter((entry, index) => {
    const id = listOf(entry);
    return id === undefined || last.get(id) === index;
  });
}
