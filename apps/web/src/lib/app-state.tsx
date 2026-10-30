/**
 * App-wide state every screen shares: the bot/session/model lists, the main
 * bot, and which bots have an approval waiting on the owner (polled, REST has
 * no push). Provided once in the root layout so screens never refetch it.
 */
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api } from "./api";
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
}

const AppContext = createContext<AppState | null>(null);

function useAttention(): ReadonlySet<string> {
  const [attention, setAttention] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const pending = await api.pendingApprovals();
        if (alive) setAttention(new Set(pending.map((row) => row.profile)));
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
  return attention;
}

function useBusy(): ReadonlySet<string> {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const rows = await api.tasks();
        if (alive)
          setBusy(
            new Set(
              rows
                .filter((row) => row.status === "running" && row.bot !== undefined)
                .map((row) => row.bot?.profileId ?? ""),
            ),
          );
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
  return busy;
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const sessions = useSessions();
  const attention = useAttention();
  const busy = useBusy();
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
