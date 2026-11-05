/**
 * The rules of the `react` ack, pure so the tool and the tests read the same
 * table: vocabulary validation, last-write-wins replacement, and the refusals
 * (unknown emoji, unknown or foreign target). One reaction per entry per
 * reactor; a second react on the same entry REPLACES the earlier one.
 */
import { REACTION_EMOJI, type ReactionName, type ReactionRow } from "@spriessen/contracts";
import { NotFound } from "@spriessen/core";
import { INPUT_ENTRY_KIND } from "../converse/steps.ts";

/** Whether an entry record kind carries an owner message a bot may react to. */
export const isOwnerEntry = (kind: string): boolean =>
  kind === "pi.user" || kind === INPUT_ENTRY_KIND;

export type ReactApply =
  | { ok: true; rows: ReactionRow[]; entryId: number }
  | { ok: false; error: string };

/**
 * Apply one react to the rows. Throws the kernel NotFound when `target`
 * names no entry of this conversation (the caller resolves the default and
 * validates the entry BEFORE calling, so a throw here is a bad id).
 */
export const applyReaction = (
  rows: readonly ReactionRow[],
  input: { emoji: string; target: number },
  reactorProfileId: string,
  /** The owner-message transcript ids of this conversation (the joinable shape). */
  reactableIds: readonly number[],
): ReactApply => {
  if (!(input.emoji in REACTION_EMOJI)) {
    return {
      ok: false,
      error: `unknown reaction "${String(input.emoji)}": use one of the fixed names`,
    };
  }
  if (!reactableIds.includes(input.target)) {
    throw new NotFound({ what: `message ${input.target} in this chat` });
  }
  // Last write wins: the reactor's earlier row for this entry gives way.
  const next = rows.filter(
    (row) => !(row.entryId === input.target && row.reactorProfileId === reactorProfileId),
  );
  next.push({
    entryId: input.target,
    emoji: input.emoji as ReactionName,
    reactorProfileId,
    createdAt: Date.now(),
  });
  return { ok: true, rows: next, entryId: input.target };
};
