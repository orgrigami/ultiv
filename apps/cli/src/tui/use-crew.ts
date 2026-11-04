/**
 * What the TUI shows around the chat — the crew, the main bot, the cards
 * waiting on the owner and the failed tasks — loaded over REST and
 * refetched when the `/push` socket says a slice changed (never polled).
 */
import { useCallback, useEffect, useState } from "react";
import type { ProfileInfo, TaskRow } from "@spriessen/contracts";
import type { Api, ApprovalRow } from "../client/http.ts";
import type { Live } from "../client/live.ts";

export interface Crew {
  readonly bots: readonly ProfileInfo[];
  readonly mainId: string | null;
  readonly approvals: readonly ApprovalRow[];
  readonly failed: readonly TaskRow[];
  readonly error: string | null;
  readonly refresh: () => void;
}

const WATCHED = new Set(["sync", "profiles", "sessions", "approvals", "tasks", "needs-you"]);

export const useCrew = (api: Api, live: Live): Crew => {
  const [bots, setBots] = useState<readonly ProfileInfo[]>([]);
  const [mainId, setMainId] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<readonly ApprovalRow[]>([]);
  const [failed, setFailed] = useState<readonly TaskRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let active = true;
    Promise.all([api.profiles(), api.main(), api.approvals(), api.tasks()])
      .then(([all, main, waiting, tasks]) => {
        if (!active) return;
        setBots(all.filter((bot) => bot.archivedAt === null));
        setMainId(main.profileId);
        setApprovals(waiting);
        setFailed(tasks.filter((task) => task.status === "failed"));
        setError(null);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, [api, tick]);

  useEffect(
    () =>
      live.subscribe((kind) => {
        if (WATCHED.has(kind)) refresh();
      }),
    [live, refresh],
  );

  return { bots, mainId, approvals, failed, error, refresh };
};
