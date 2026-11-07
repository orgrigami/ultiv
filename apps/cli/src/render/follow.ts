/**
 * Following a turn as it happens, for `ask` in a terminal: fed every
 * snapshot, it answers the text to write since the last one — tool calls
 * as they finish (a running one shows as a live "…" line that is rewritten
 * when it ends), the reply streamed as it is written, machinery and notes
 * as dim lines. Entries print strictly in transcript order: it never runs
 * ahead of a running tool or a reply still being written.
 */
import type { TranscriptEntry } from "@spriessen/contracts";
import type { Paint } from "./out.ts";
import { entryLines, machineryLine, reactionLine, toolLine } from "./words.ts";

export interface Follower {
  /** The text to write for the entries after `afterId` (our input). */
  readonly feed: (entries: readonly TranscriptEntry[], afterId: number) => string;
}

const CLEAR_LINE = "\r\u001b[2K";

const toolText = (entry: Extract<TranscriptEntry, { kind: "tool" }>, paint: Paint): string => {
  const line = toolLine(entry.step);
  if (line === null) return "";
  const mark =
    line.status === "error"
      ? paint.red("✗")
      : line.status === "running"
        ? paint.amber("…")
        : paint.green("✓");
  const detail = line.detail !== null ? paint.dim(` — ${line.detail}`) : "";
  const error = line.error !== null ? `\n    ${paint.red(line.error)}` : "";
  return `  ${mark} ${line.title}${detail}${error}`;
};

export const createFollower = (bot: string, paint: Paint): Follower => {
  const done = new Set<number>();
  let partial: { id: number; chars: number } | undefined;
  /** A running tool's line is on screen, without its newline. */
  let liveTool: number | undefined;
  /** The output so far ended mid-line. */
  let midLine = false;

  const emit = (entry: TranscriptEntry): string => {
    const machinery = machineryLine(entry);
    if (machinery === null) return "";
    const quiet = machinery ?? reactionLine(entry, bot);
    if (quiet !== null) return `${paint.dim(`· ${quiet}`)}\n`;
    if (entry.kind === "tool") {
      const text = toolText(entry, paint);
      return text === "" ? "" : `${text}\n`;
    }
    const lines = entryLines(entry, bot);
    return lines.length === 0 ? "" : `${paint.dim(lines.join("\n"))}\n`;
  };

  const stream = (entry: Extract<TranscriptEntry, { kind: "output" }>): string => {
    let out = "";
    if (partial?.id !== entry.id) {
      partial = { id: entry.id, chars: 0 };
      out += `\n${paint.bold(bot)}${entry.interrupted === true ? paint.dim(" (cut short)") : ""}\n`;
    }
    const fresh = entry.text.slice(partial.chars);
    if (fresh !== "") {
      out += fresh;
      partial.chars = entry.text.length;
      midLine = !entry.text.endsWith("\n");
    }
    return out;
  };

  return {
    feed: (entries, afterId) => {
      let out = "";
      for (const entry of entries) {
        if (entry.id <= afterId || done.has(entry.id)) continue;
        if (entry.kind === "tool" && entry.step.status === "running") {
          if (liveTool !== entry.id) {
            const text = toolText(entry, paint);
            if (text !== "") {
              out += text;
              liveTool = entry.id;
            }
          }
          break;
        }
        if (liveTool !== undefined) {
          out += CLEAR_LINE;
          liveTool = undefined;
        }
        if (entry.kind === "output") {
          out += stream(entry);
          if (entry.streaming) break;
          if (midLine) out += "\n";
          midLine = false;
          done.add(entry.id);
          continue;
        }
        if (entry.kind !== "thinking") out += emit(entry);
        done.add(entry.id);
      }
      return out;
    },
  };
};

/** The reply's words alone (stdout in a pipe): every finished reply after our input. */
export const replyText = (entries: readonly TranscriptEntry[]): string =>
  entries
    .filter(
      (entry): entry is Extract<TranscriptEntry, { kind: "output" }> =>
        entry.kind === "output" && entry.text !== "",
    )
    .map((entry) => entry.text.trimEnd())
    .join("\n\n");
