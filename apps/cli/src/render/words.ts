/**
 * The terminal's words for a chat, from the SAME lens the web renders
 * through (@spriessen/present): a tool call's owner-worded title (present
 * tense while it runs), its one detail, an error as a sentence; an approval
 * card's "Wren wants to …" with its hint and risk. Line mode prints these;
 * the TUI colours them.
 */
import type { PendingApproval, ToolStep, TranscriptEntry } from "@spriessen/contracts";
import {
  alwaysAllowText,
  canAlwaysAllow,
  describeTool,
  hintOf,
} from "@spriessen/present/approval-text";
import { errorTextOf, presentationOf } from "@spriessen/present/tool-text";

export interface ToolLine {
  readonly status: ToolStep["status"];
  readonly title: string;
  readonly detail: string | null;
  readonly error: string | null;
}

/** One tool call in owner words, or null for calls the web hides (Jev, `now`). */
export const toolLine = (step: ToolStep): ToolLine | null => {
  const shown = presentationOf(step);
  if (shown.kind === "hidden") return null;
  const view = shown.view;
  const error = errorTextOf(step) ?? null;
  return {
    status: step.status,
    title: step.status === "running" ? view.live : view.done,
    detail: view.detail ?? null,
    error,
  };
};

export interface CardWords {
  readonly callId: string;
  /** Completes "<bot> wants to …". */
  readonly action: string;
  readonly hint: string | null;
  readonly risky: boolean;
  readonly risk: string;
  /** The Always-allow label, or null when this card can never be always-allowed. */
  readonly always: string | null;
}

export const cardWords = (pending: NonNullable<PendingApproval>): CardWords => {
  const described = describeTool(pending.name);
  return {
    callId: pending.callId,
    action: described.action,
    hint: hintOf(pending.input),
    risky: described.risky,
    risk: pending.reason ?? described.risk,
    always: canAlwaysAllow(pending.name)
      ? alwaysAllowText(pending.name, pending.input).title
      : null,
  };
};

const time = (at: number): string => new Date(at).toTimeString().slice(0, 5);

/** A transcript entry as plain text lines (line mode); empty for hidden entries. */
export const entryLines = (entry: TranscriptEntry, bot: string): string[] => {
  switch (entry.kind) {
    case "input":
      return [`you ${time(entry.at)}`, ...entry.text.split("\n").map((line) => `  ${line}`)];
    case "output":
      return [
        `${bot}${entry.interrupted === true ? " (cut short)" : ""}`,
        ...entry.text.split("\n").map((line) => `  ${line}`),
      ];
    case "thinking":
      return [];
    case "note":
      return [`· ${entry.text}`];
    case "tool": {
      const line = toolLine(entry.step);
      if (line === null) return [];
      const head = `  ${line.status === "error" ? "✗" : line.status === "running" ? "…" : "✓"} ${line.title}`;
      const detail = line.detail !== null ? ` — ${line.detail}` : "";
      return [`${head}${detail}`, ...(line.error !== null ? [`    ${line.error}`] : [])];
    }
  }
};
