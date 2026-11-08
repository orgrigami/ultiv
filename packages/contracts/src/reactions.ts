/**
 * The `react` tool's vocabulary: a bot puts one of four reactions on the
 * owner's message. The names are the contract; the emoji maps at render.
 * Nothing is stored apart from the call itself: the web reads each
 * reaction from the transcript (the tool step's `details`), so a chip
 * arrives with the chat's own live updates.
 */
import { obj, oneOf, type Static } from "@earendil-works/pi-schema";

export const REACTIONS_TOOL = "react";

/** The four reactions, in display order. The list is FIXED. */
export const REACTION_NAMES = ["ok", "no", "looking", "done"] as const;
export type ReactionName = (typeof REACTION_NAMES)[number];

/** The emoji each name renders as. */
export const REACTION_EMOJI: Readonly<Record<ReactionName, string>> = {
  ok: "👍",
  no: "👎",
  looking: "👀",
  done: "✅",
};

/** Owner-facing words for each reaction (tooltips, screen readers). */
export const REACTION_LABEL: Readonly<Record<ReactionName, string>> = {
  ok: "Got it",
  no: "Won't do",
  looking: "Looking into it",
  done: "Done",
};

/**
 * The reactions that end the bot's turn: nothing follows them, so the run
 * stops without another model request. `looking` is the early ack of work
 * the bot is about to do in the same turn, so the turn goes on.
 */
export const ENDS_TURN: ReadonlySet<ReactionName> = new Set(["ok", "no", "done"]);

/**
 * No target parameter: the model never sees transcript ids, so it could
 * only guess one. A reaction always marks the owner's latest message.
 */
export const ReactionParamsSchema = obj(
  {
    reaction: oneOf(REACTION_NAMES, {
      description: "ok, no, looking or done.",
    }),
  },
  { open: true },
);
export type ReactionParams = Static<typeof ReactionParamsSchema>;

/** The `details` a successful react call carries: the transcript id it marks. */
export type ReactionDetails = {
  /** The TranscriptEntry id of the owner's message. */
  target: number;
  reaction: ReactionName;
};

const isName = (value: unknown): value is ReactionName =>
  typeof value === "string" && (REACTION_NAMES as readonly string[]).includes(value);

/** A react call's details, or undefined when they are not this shape. */
export const reactionDetailsOf = (details: unknown): ReactionDetails | undefined => {
  if (details === null || typeof details !== "object") return undefined;
  const { target, reaction } = details as { target?: unknown; reaction?: unknown };
  return typeof target === "number" && isName(reaction) ? { target, reaction } : undefined;
};
