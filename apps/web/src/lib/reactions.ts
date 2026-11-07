/**
 * The bot's reactions, read from the transcript the chat already holds: each
 * successful `react` call's details name the owner's message it marks. No
 * store, no REST, no polling: a chip arrives with the chat's own live
 * updates. A later reaction on the same message replaces the earlier one.
 * The successful calls leave the transcript before grouping, so a
 * reaction-only reply draws no empty bot turn, only the chip.
 */
import {
  REACTIONS_TOOL,
  reactionDetailsOf,
  type ReactionName,
  type TranscriptEntry,
} from "@spriessen/contracts";

const isShownReaction = (entry: TranscriptEntry): boolean =>
  entry.kind === "tool" && entry.step.name === REACTIONS_TOOL && entry.step.status === "done";

/** The reaction on each owner message, by its transcript id. */
export function reactionsOf(
  transcript: readonly TranscriptEntry[],
): ReadonlyMap<number, ReactionName> {
  const byMessage = new Map<number, ReactionName>();
  for (const entry of transcript) {
    if (entry.kind !== "tool" || !isShownReaction(entry)) continue;
    const details = reactionDetailsOf(entry.step.details);
    if (details !== undefined) byMessage.set(details.target, details.reaction);
  }
  return byMessage;
}

/** The transcript without the successful react calls: their chips stand in for them. */
export const withoutReactions = (transcript: TranscriptEntry[]): TranscriptEntry[] =>
  transcript.some(isShownReaction)
    ? transcript.filter((entry) => !isShownReaction(entry))
    : transcript;
