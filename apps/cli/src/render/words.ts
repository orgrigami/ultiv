/**
 * The terminal's words for a chat, from the SAME lens the web renders
 * through (@spriessen/present): a tool call's owner-worded title (present
 * tense while it runs), its one detail, an error as a sentence; an approval
 * card's "Wren wants to …" with its hint and risk. Line mode prints these;
 * the TUI colours them.
 */
import {
  isNothingToReport,
  NOTHING_TO_REPORT_WORDS,
  type PendingApproval,
  type ToolStep,
  type TranscriptEntry,
} from "@spriessen/contracts";
import {
  alwaysAllowText,
  canAlwaysAllow,
  describeTool,
  hintOf,
} from "@spriessen/present/approval-text";
import { errorTextOf, presentationOf } from "@spriessen/present/tool-text";
import { systemLine } from "@spriessen/present/system-line";
import { parseSystem } from "@spriessen/present/system-text";
import {
  REACTION_EMOJI,
  REACTION_LABEL,
  REACTIONS_TOOL,
  reactionDetailsOf,
} from "@spriessen/contracts";

/**
 * A machinery input or note (a task's result, a routine's wake, bot mail…)
 * as one line of owner words; null when it is hidden; undefined when the
 * entry is not machinery at all (a message you typed, a plain note).
 */
export const machineryLine = (entry: TranscriptEntry): string | null | undefined => {
  if (entry.kind !== "input" && entry.kind !== "note") return undefined;
  const message = parseSystem(entry.text);
  return message === null ? undefined : systemLine(message);
};

/** A bot's reaction on your message, as a line; null when the entry is not one. */
export const reactionLine = (entry: TranscriptEntry, bot: string): string | null => {
  if (entry.kind !== "tool" || entry.step.name !== REACTIONS_TOOL || entry.step.status !== "done") {
    return null;
  }
  const details = reactionDetailsOf(entry.step.details);
  return details === undefined
    ? null
    : `${bot} reacted ${REACTION_EMOJI[details.reaction]} ${REACTION_LABEL[details.reaction]}`;
};

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
  const machinery = machineryLine(entry);
  if (machinery !== undefined) return machinery === null ? [] : [`· ${machinery}`];
  const reaction = reactionLine(entry, bot);
  if (reaction !== null) return [`· ${reaction}`];
  switch (entry.kind) {
    case "input":
      return [`you ${time(entry.at)}`, ...entry.text.split("\n").map((line) => `  ${line}`)];
    case "output":
      if (entry.streaming !== true && isNothingToReport(entry.text))
        return [`· ${bot}: ${NOTHING_TO_REPORT_WORDS.toLowerCase()}`];
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
