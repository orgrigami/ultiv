/**
 * The task sheet's timeline: raw activity steps become ordered items (tool
 * calls, thinking, notes, bot messages), with the brief and the final result
 * dropped because they have their own rows. Tool rows carry only the raw
 * call; their words come from the ONE presentation lens (`tool-text.ts`
 * `presentationOf`) through `toolStepOf`, the same as in a chat — there is
 * no second tool vocabulary here to drift. Pure, so it is unit-tested;
 * malformed or legacy steps never throw.
 */
import type { TaskActivity } from "@/lib/api";
import type { ToolStep as ToolStepContract } from "@spriessen/contracts";

export type ActivityStep = TaskActivity["steps"][number];

export type TimelineItem =
  | {
      kind: "tool";
      key: string;
      name: string;
      status: "running" | "done" | "error";
      durationMs: number | null;
      inputRaw: unknown;
      outputRaw: unknown;
    }
  | { kind: "thinking"; key: string; text: string }
  | { kind: "message"; key: string; text: string }
  | { kind: "note"; key: string; text: string }
  | { kind: "input"; key: string; text: string };

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

const UPDATE_PREFIX = /^\[task [^\]]*update\]\s*/;
const same = (a: string, b: string): boolean => {
  const x = a.trim();
  const y = b.trim();
  return x !== "" && (y.startsWith(x.replace(/…$/, "")) || x.startsWith(y));
};

function toolItem(step: ActivityStep, key: string, text: string): TimelineItem {
  const tool = step.tool;
  // Older servers only send "name → output"; read the name back out of it.
  const name = tool?.name ?? text.split(/\s+(?:→|…)/)[0]?.trim() ?? "";
  const legacyOutput = tool === undefined ? (text.split(" → ")[1] ?? null) : null;
  return {
    kind: "tool",
    key,
    name,
    status: tool?.status ?? (text.endsWith(" …") ? "running" : "done"),
    durationMs: tool?.durationMs ?? null,
    inputRaw: tool?.input ?? null,
    outputRaw: tool?.output ?? legacyOutput,
  };
}

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
