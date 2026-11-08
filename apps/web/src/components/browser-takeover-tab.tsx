/**
 * Crew › bot › Browser: the owner's side of a takeover. A bot that meets an
 * identity wall in its browser session asks (browser_session op takeover);
 * its ask appears here the moment it happens (the "takeovers" live signal).
 * Each ask opens as a LIVE view of the bot's browser that the owner drives
 * directly — clicks, typing, the wheel, the url bar (takeover-live-card).
 * The bot's call BLOCKS while you drive; Finish hands the page straight
 * back to it, mid-task. While a takeover is open the bot's own acts (and
 * page opens) are refused.
 */
import { useCallback, useEffect, useState } from "react";
import { SectionHeader } from "@/components/ui/section-header";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { TakeoverLiveCard, type TakeoverRowView } from "@/components/takeover-live-card";
import { api } from "@/lib/api";
import { useLiveRefresh } from "@/lib/use-live-refresh";

export function BrowserTakeoverTab() {
  const [rows, setRows] = useState<TakeoverRowView[] | null>(null);
  const [error, setError] = useState(false);
  const reload = useCallback(async (): Promise<void> => {
    try {
      setRows((await api.browserTakeovers()).takeovers);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => void reload(), [reload]);
  // A bot's ask (or a finish) signals: the list follows without polling.
  useLiveRefresh(["takeovers"], reload);
  return (
    <section aria-label="Browser" className="flex flex-col gap-3">
      <SectionHeader title="Browser" />
      {error && rows === null ? (
        <ErrorState message="Couldn't load the takeovers." onRetry={() => void reload()} />
      ) : rows === null ? (
        <SkeletonRows label="Loading takeovers" rows={1} />
      ) : rows.length === 0 ? (
        <EmptyState className="py-8">
          No takeover open. When a bot meets a sign-in, a code or a CAPTCHA in its browser session,
          its ask appears here.
        </EmptyState>
      ) : (
        rows.map((row) => <TakeoverLiveCard key={row.id} row={row} onGone={reload} />)
      )}
      <p className="text-muted-foreground text-xs">
        While you hold the controls, the bot's own browser acts (even opening a page) are refused
        and its takeover call waits; Finish hands the page straight back to it. The view is the
        bot's browser, live — click the page and type as if it were yours.
      </p>
    </section>
  );
}
