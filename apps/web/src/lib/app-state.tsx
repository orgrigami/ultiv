/**
 * App-wide state every screen shares: the bot/session/model lists, the main
 * bot, which bots have an approval waiting on the owner and which are busy
 * (polled, REST has no push), and the "Needs you" list built from those same
 * polls plus one unpolled read. Provided once in the root layout so screens
 * never refetch it.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { TaskRow } from "@ultiv/contracts";
import { api, type PendingApprovalRow } from "./api";
import {
  needsYouItems,
  readDismissed,
  writeDismissed,
  type NeedsItem,
  type NeedsYouExtra,
} from "./needs-you.ts";
import { notifyError, pollFailed, pollRecovered } from "./notify.ts";
import { useSessions } from "./use-sessions";

export interface AppState {
  sessions: ReturnType<typeof useSessions>;
  mainId: string | null;
  /** Bot ids with an approval waiting on the owner. */
  attention: ReadonlySet<string>;
  /** Bot ids with a background task running right now. */
  busy: ReadonlySet<string>;
  /** Bumps on every refreshAll, so screens re-resolve a bot's main chat. */
  epoch: number;
  reloadMain: () => Promise<void>;
  /** Re-read the main bot and the session lists (after any bot change). */
  refreshAll: () => Promise<void>;
  /** The bot last chatted with (undefined = main), so the Chat tab returns to it. */
  lastBot: string | undefined;
  setLastBot: (id: string | undefined) => void;
  /** The Needs you list (approvals, failed tasks, escalations, tidy). */
  needs: NeedsItem[];
  needsCount: number;
  /** Re-read the unpolled Needs you inputs (tidy counts, escalations). */
  reloadNeeds: () => Promise<void>;
  dismissNeed: (id: string) => void;
}

const AppContext = createContext<AppState | null>(null);

function useApprovals(): readonly PendingApprovalRow[] {
  const [approvals, setApprovals] = useState<readonly PendingApprovalRow[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const pending = await api.pendingApprovals();
        if (alive) setApprovals(pending);
        pollRecovered("approvals-poll");
      } catch (cause) {
        // Keep the last known set, but say the badges may be stale.
        pollFailed("approvals-poll", "Approval badges may be out of date", cause);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return approvals;
}

function useTasks(): readonly TaskRow[] {
  const [tasks, setTasks] = useState<readonly TaskRow[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const rows = await api.tasks();
        if (alive) setTasks(rows);
        pollRecovered("busy-poll");
      } catch (cause) {
        // Keep the last known set, but say the spinners may be stale.
        pollFailed("busy-poll", "Running indicators may be out of date", cause);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return tasks;
}

/** The unpolled inputs: read on mount, on focus, and when a screen asks. */
function useNeedsExtra(): [NeedsYouExtra | null, () => Promise<void>] {
  const [extra, setExtra] = useState<NeedsYouExtra | null>(null);
  const reload = useCallback(async () => {
    try {
      setExtra(await api.needsYou());
    } catch {
      // Keep the last known list; approvals and tasks still come from the polls.
    }
  }, []);
  useEffect(() => {
    void reload();
    const onFocus = (): void => void reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);
  return [extra, reload];
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const sessions = useSessions();
  const approvals = useApprovals();
  const tasks = useTasks();
  const [extra, reloadNeeds] = useNeedsExtra();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(readDismissed);
  const attention = useMemo(() => new Set(approvals.map((row) => row.profile)), [approvals]);
  const busy = useMemo(
    () =>
      new Set(
        tasks
          .filter((row) => row.status === "running" && row.bot !== undefined)
          .map((row) => row.bot?.profileId ?? ""),
      ),
    [tasks],
  );
  const needs = useMemo(
    () =>
      needsYouItems({
        approvals,
        tasks,
        extra,
        profiles: sessions.profiles,
        dismissed,
        now: Date.now(),
      }),
    [approvals, tasks, extra, sessions.profiles, dismissed],
  );
  const dismissNeed = useCallback((id: string) => {
    setDismissed((current) => {
      const next = new Set(current).add(id);
      writeDismissed(next);
      return next;
    });
  }, []);
  const [mainId, setMainId] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [lastBot, setLastBot] = useState<string | undefined>(undefined);

  const reloadMain = useCallback(async () => {
    try {
      setMainId((await api.main()).profileId);
    } catch (cause) {
      setMainId(null);
      notifyError("Couldn't load the main bot", cause, "main-load");
    }
  }, []);

  useEffect(() => {
    void reloadMain();
  }, [reloadMain]);

  const { select, selected } = sessions;
  const refreshAll = useCallback(async () => {
    await reloadMain();
    setEpoch((value) => value + 1);
    select(selected);
  }, [reloadMain, select, selected]);

  return (
    <AppContext.Provider
      value={{
        sessions,
        mainId,
        attention,
        busy,
        epoch,
        reloadMain,
        refreshAll,
        lastBot,
        setLastBot,
        needs,
        needsCount: needs.length,
        reloadNeeds,
        dismissNeed,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp(): AppState {
  const state = useContext(AppContext);
  if (state === null) throw new Error("useApp must be used inside <AppProvider>");
  return state;
}
