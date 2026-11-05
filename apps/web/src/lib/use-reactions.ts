/**
 * This chat's bot reactions (the acks): fetched when the session opens and
 * polled every 5 s, matching the app's other REST polls (REST has no push).
 * Merged by transcript entry id, so a chip lands on the bubble it reacts to
 * and a re-react replaces it in place. The react tool call itself is hidden
 * in the presentation lens: a reaction-only turn shows just the chip.
 */
import { useCallback, useEffect, useState } from "react";
import type { ReactionRow } from "@spriessen/contracts";
import { api } from "@/lib/api";

/** The rows as a lookup by the transcript entry id the chip attaches to. */
export const reactionsByEntry = (
  rows: readonly ReactionRow[],
): ReadonlyMap<number, ReactionRow> => {
  const byEntry = new Map<number, ReactionRow>();
  // Last write wins per entry: the freshest row of a re-reacted message.
  for (const row of rows) byEntry.set(row.entryId, row);
  return byEntry;
};

export function useReactions(sessionId: string): ReadonlyMap<number, ReactionRow> {
  const [rows, setRows] = useState<ReadonlyMap<number, ReactionRow>>(() => new Map());

  const refresh = useCallback(async () => {
    setRows(reactionsByEntry((await api.sessionReactions(sessionId)).reactions));
  }, [sessionId]);

  useEffect(() => {
    setRows(new Map());
    const tick = (): void => {
      void refresh().catch(() => {
        // A failed poll keeps the last known chips; the next tick retries.
      });
    };
    tick();
    const timer = setInterval(tick, 5_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return rows;
}
