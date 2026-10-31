/**
 * The always-on plan strip above the composer: which plan to show, and the
 * one line it reads ("Tasks 2/4 · Upload it"). Pure, so the rules are tested
 * without a browser; the strip component only adds the timer and the toggle.
 */
import { CHECKLIST_TOOL, type ChecklistDetails, type ToolStep } from "@spriessen/contracts";
import { checklistOf } from "./chat-tool-views.ts";

/** How long a finished plan stays on the strip before it folds away. */
export const DONE_LINGER_MS = 6_000;

/** The chat's current plan: the latest settled checklist call, or null. */
export function currentPlan<T extends { kind: string; step?: ToolStep }>(
  transcript: readonly T[],
): ChecklistDetails | null {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const step = transcript[index]?.step;
    if (transcript[index]?.kind !== "tool" || step?.name !== CHECKLIST_TOOL) continue;
    if (step.status !== "done") continue;
    const list = checklistOf(step.details);
    if (list !== null) return list;
  }
  return null;
}

export interface StripLine {
  done: number;
  total: number;
  /** The step in progress, else the next one to do; null once all are done. */
  current: string | null;
  finished: boolean;
}

export function stripLine(list: ChecklistDetails): StripLine {
  const done = list.items.filter((item) => item.status === "done").length;
  const next =
    list.items.find((item) => item.status === "in_progress") ??
    list.items.find((item) => item.status === "pending");
  return {
    done,
    total: list.items.length,
    current: next?.text ?? null,
    finished: done === list.items.length,
  };
}

/** A stable key for "this plan, in this state": the strip re-renders only on change. */
export const planKey = (list: ChecklistDetails | null): string =>
  list === null
    ? ""
    : `${list.listId}|${list.title ?? ""}|${list.items.map((item) => `${item.status}:${item.text}`).join("\u0001")}`;
