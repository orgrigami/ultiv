/**
 * The owner's bots' browsers, live: the open takeover asks (each a bot call
 * waiting on the owner) and every browser session going, refetched on the
 * "takeovers" signal — an ask opening or closing, a session moving to a new
 * page — never polled. Shared by the Browsers panel, the Crew Browser tab
 * and the chat's browser chip.
 */
import { useCallback, useEffect, useState } from "react";
import { api, type BrowserSessionRow } from "./api.ts";
import { useLiveRefresh } from "./use-live-refresh.ts";

export interface TakeoverAsk {
  readonly id: string;
  readonly conversationId: string;
  readonly reason: string;
  readonly openedAt: number;
  readonly profileId: string | null;
  readonly botName: string;
}

export interface Browsers {
  /** Null until the first load lands. */
  readonly asks: readonly TakeoverAsk[] | null;
  /** Sessions with no ask open on them (those show as the ask's card). */
  readonly watching: readonly BrowserSessionRow[] | null;
  readonly failed: boolean;
  readonly reload: () => Promise<void>;
}

/** All bots, or one bot's (`botId`). */
export function useBrowsers(botId?: string): Browsers {
  const [asks, setAsks] = useState<readonly TakeoverAsk[] | null>(null);
  const [sessions, setSessions] = useState<readonly BrowserSessionRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(async (): Promise<void> => {
    try {
      const [takeovers, browsers] = await Promise.all([
        api.browserTakeovers(),
        api.browserSessions(),
      ]);
      setAsks(takeovers.takeovers);
      setSessions(browsers.sessions);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => void reload(), [reload]);
  useLiveRefresh(["takeovers"], reload);
  const mine = <T extends { readonly profileId: string | null }>(rows: readonly T[]) =>
    botId === undefined ? rows : rows.filter((row) => row.profileId === botId);
  return {
    asks: asks === null ? null : mine(asks),
    watching: sessions === null ? null : mine(sessions).filter((row) => row.takeoverId === null),
    failed,
    reload,
  };
}
