/**
 * Where a fact came from, in words a model can act on. The recalled-memories
 * block carries a short cue per line (who it came from, the day learned);
 * `memory_history` expands it into the evidence itself: the chat it was
 * learned in and the note it was saved from. One module, so the cue and the
 * expansion never disagree.
 */
import type { FactSource, SessionKind } from "@spriessen/contracts";
import { dayOf } from "./handles.ts";

const ORIGIN_WORDS: Record<string, string> = {
  owner: "the owner",
  cron: "a routine",
  task: "a task",
  webhook: "a webhook",
  sensor: "a watch",
  bot: "another bot",
  forget: "a retraction",
};

/** Who a fact came from: the input's origin, or the owner's own panel. */
export const originWords = (source: Pick<FactSource, "origin" | "via">): string => {
  if (source.via === "rest") return "the owner, in the Memory panel";
  return ORIGIN_WORDS[source.origin] ?? "an unknown source";
};

const CHAT_WORDS: Record<SessionKind, string> = {
  main: "the main chat",
  session: "a chat",
  dm: "a direct thread",
  room: "a bot talk",
  task: "a task",
};

/**
 * The short cue on a recalled line: "from the owner", plus the day it was
 * learned when that differs from the day the line already shows (both days
 * formatted by the caller, the way its line formats dates).
 */
export const sourceCue = (
  source: Pick<FactSource, "origin" | "via">,
  learnedDay: string,
  shownDay: string,
): string =>
  `from ${originWords(source)}${learnedDay === shownDay ? "" : `, learned ${learnedDay}`}`;

const NOTE_CHARS = 240;

/**
 * The evidence line under one version in `memory_history`: who, when,
 * which chat (by kind; history_search on that day finds the words), and the
 * note it was saved from, when still kept.
 */
export const evidenceLine = (entry: {
  readonly source: Pick<FactSource, "origin" | "via">;
  readonly learnedAt: number;
  readonly chat: SessionKind | null;
  readonly note: string | null;
}): string => {
  const where = entry.chat === null ? "" : ` in ${CHAT_WORDS[entry.chat]}`;
  const note =
    entry.note === null
      ? " (the note it was saved from is gone)"
      : `: "${entry.note.length > NOTE_CHARS ? `${entry.note.slice(0, NOTE_CHARS - 1)}…` : entry.note}"`;
  return `learned ${dayOf(entry.learnedAt)} from ${originWords(entry.source)}${where}${note}`;
};
