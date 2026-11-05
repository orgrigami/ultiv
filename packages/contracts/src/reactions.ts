/**
 * The `react` ack vocabulary and the REST row it stores: a bot attaches one
 * emoji from this fixed 12-name list to the owner's message instead of
 * writing prose. The names are the contract; the emoji maps at render.
 * Plain-REST payload (read through GET /api/sessions/:id/reactions), never
 * a chord object.
 */
import { Type, type Static } from "typebox";

export const REACTIONS_TOOL = "react";

/** The owner-approved ack names, in display order. The list is FIXED. */
export const REACTION_NAMES = [
  "ack",
  "seen",
  "done",
  "working",
  "declined",
  "clarify",
  "caveat",
  "blocked",
  "noted",
  "recurs",
  "shipped",
  "agreed",
] as const;
export type ReactionName = (typeof REACTION_NAMES)[number];

/** The emoji each name renders as. One entry per name, no aliases. */
export const REACTION_EMOJI: Readonly<Record<ReactionName, string>> = {
  ack: "👍",
  seen: "👀",
  done: "✅",
  working: "⏳",
  declined: "❌",
  clarify: "❓",
  caveat: "⚠️",
  blocked: "🚫",
  noted: "📌",
  recurs: "🔁",
  shipped: "🎉",
  agreed: "🤝",
};

export const ReactionParamsSchema = Type.Object({
  emoji: Type.Union(
    REACTION_NAMES.map((name) => Type.Literal(name)),
    {
      description: "One of the fixed reaction names.",
    },
  ),
  target: Type.Optional(
    Type.Number({
      description: "Transcript id of the owner message to react to. Default: the most recent one.",
    }),
  ),
});
export type ReactionParams = Static<typeof ReactionParamsSchema>;

/** One stored reaction: joined to the web transcript by entryId. */
export type ReactionRow = {
  /** The transcript entry id the chip attaches to (an owner message). */
  entryId: number;
  emoji: ReactionName;
  reactorProfileId: string;
  createdAt: number;
};

export const ReactionRowSchema = Type.Object({
  entryId: Type.Number(),
  emoji: Type.Union(REACTION_NAMES.map((name) => Type.Literal(name))),
  reactorProfileId: Type.String(),
  createdAt: Type.Number(),
});

/** GET /api/sessions/:sessionId/reactions. */
export const ReactionsListSchema = Type.Object({
  reactions: Type.Array(ReactionRowSchema),
});
export type ReactionsList = Static<typeof ReactionsListSchema>;
