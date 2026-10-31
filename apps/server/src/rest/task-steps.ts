/**
 * The task activity view's steps: the projected transcript tail, size-capped.
 * Tool steps carry their name, status, duration and capped input/output so
 * the sheet can say "Read plato.stanford.edu" and still show the raw call on
 * request; `text` stays as the old one-line form for older clients.
 */
import type { TranscriptEntry } from "@spreissen/contracts";

export interface ActivityTool {
  name: string;
  status: "running" | "done" | "error";
  /** The call's arguments, or a capped JSON string when they are large. */
  input: unknown;
  output: string | null;
  durationMs: number | null;
}

export interface ActivityStep {
  kind: string;
  at: number;
  text: string;
  tool?: ActivityTool;
}

const TAIL = 40;
const TEXT_CHARS = 2_000;
const INPUT_CHARS = 2_000;
const OUTPUT_CHARS = 4_000;

const cap = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** Small inputs pass through as-is; large ones become a capped JSON string. */
function cappedInput(input: unknown): unknown {
  let json: string;
  try {
    json = JSON.stringify(input) ?? "";
  } catch {
    return null;
  }
  return json.length > INPUT_CHARS ? cap(json, INPUT_CHARS) : input;
}

export function activitySteps(entries: readonly TranscriptEntry[]): ActivityStep[] {
  return entries.slice(-TAIL).map((entry) => {
    if (entry.kind !== "tool")
      return { kind: entry.kind, at: entry.at, text: cap(entry.text, TEXT_CHARS) };
    const { name, status, input, output, durationMs } = entry.step;
    return {
      kind: "tool",
      at: entry.at,
      text: `${name}${output ? ` → ${output.slice(0, 300)}` : " …"}`,
      tool: {
        name,
        status,
        input: cappedInput(input),
        output: output === null ? null : cap(output, OUTPUT_CHARS),
        durationMs,
      },
    };
  });
}
