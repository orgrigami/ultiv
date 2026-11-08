/**
 * A running task's recent steps as short plain lines: what task_status shows
 * the bot and what the owner's live task line shows as "last step".
 */
import type { LiveState } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import type { TranscriptEntry } from "@spriessen/contracts";
import type { ConverseService } from "../converse/converse.ts";
import { projectTranscript } from "../converse/steps.ts";
import { readView, TRANSCRIPT_WINDOW } from "../converse/view.ts";
import { taskConversationKey } from "./store.ts";

const LINE_CHARS = 140;

const clip = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > LINE_CHARS ? `${flat.slice(0, LINE_CHARS - 1).trimEnd()}…` : flat;
};

/** One step as a plain line; undefined for steps not worth a line. */
export const stepLine = (entry: TranscriptEntry): string | undefined => {
  switch (entry.kind) {
    case "tool": {
      const name = entry.step.name.replace(/_/g, " ");
      if (entry.step.status === "running") return `Running ${name}…`;
      return entry.step.status === "error" ? `${name} failed` : `Used ${name}`;
    }
    case "output":
      return entry.text.trim() === "" ? undefined : `Wrote: ${clip(entry.text)}`;
    case "note":
      return clip(entry.text);
    default:
      return undefined;
  }
};

/** The last `count` meaningful steps of a task, oldest first; [] when it has none. */
export const recentSteps = async (
  converse: ConverseService,
  id: string,
  count = 3,
): Promise<string[]> => {
  const cid = await Effect.runPromise(converse.conversationIdOf(taskConversationKey(id)));
  if (cid === undefined) return [];
  const chat = await Effect.runPromise(converse.open(String(cid)));
  if (chat === undefined) return [];
  const value = await readView(chat, TRANSCRIPT_WINDOW);
  const live = value.docs["pi.live"] as LiveState | undefined;
  const lines = projectTranscript(value.entries, live, true)
    .map(stepLine)
    .filter((line): line is string => line !== undefined);
  return lines.slice(-count);
};
