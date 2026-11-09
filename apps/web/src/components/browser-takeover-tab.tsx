/**
 * Browsers: the owner's side of their bots' browser sessions. Shown on the
 * right as a work-dock tab (every bot, opened from Needs you, the chat's
 * browser chip or a takeover push) and as Crew › bot › Browser (that bot
 * only). A bot that meets an identity wall asks (browser_session op
 * takeover); its ask appears here the moment it happens (the "takeovers"
 * live signal) as a LIVE view the owner drives directly — clicks, typing,
 * the wheel, the url bar (takeover-live-card). The bot's call BLOCKS while
 * you drive; Finish hands the page straight back to it, mid-task. Every
 * other session lists below it (one per bot), with a watch-only live view
 * on demand and Close; then the bots' saved sign-ins (Forget), and — on a
 * bot's own tab — what its browser did.
 */
import { SectionHeader } from "@/components/ui/section-header";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { TakeoverLiveCard } from "@/components/takeover-live-card";
import { BrowserWatchCard } from "@/components/browser-watch-card";
import { BrowserHistory, SavedSignins } from "@/components/browser-signins";
import { useBrowsers } from "@/lib/use-browsers";

export function BrowsersPanel({ botId }: { botId?: string }) {
  const { asks, watching, failed, reload } = useBrowsers(botId);
  const showBot = botId === undefined;
  if (asks === null || watching === null) {
    return failed ? (
      <ErrorState message="Couldn't load the browsers." onRetry={() => void reload()} />
    ) : (
      <SkeletonRows label="Loading browsers" rows={1} />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {asks.length === 0 && watching.length === 0 ? (
        <EmptyState className="py-8">
          No browser is open. When a bot browses — or meets a sign-in, a code or a CAPTCHA and asks
          you to take the controls — it shows up here.
        </EmptyState>
      ) : null}
      {asks.map((row) => (
        <TakeoverLiveCard key={row.id} row={row} onGone={reload} />
      ))}
      {watching.map((row) => (
        <BrowserWatchCard key={row.conversationId} row={row} showBot={showBot} onClosed={reload} />
      ))}
      <p className="text-muted-foreground text-xs">
        Each bot has its own browser, closed when its task ends or after 10 quiet minutes. While you
        hold the controls, the bot's own browser acts (even opening a page) are refused and its
        takeover call waits; Finish hands the page straight back to it. Watching never touches the
        page.
      </p>
      <SavedSignins {...(botId !== undefined ? { botId } : {})} />
      {botId !== undefined && <BrowserHistory botId={botId} />}
    </div>
  );
}

/** Crew › bot › Browser: the same panel, this bot only. */
export function BrowserTakeoverTab({ botId }: { botId: string }) {
  return (
    <section aria-label="Browser" className="flex flex-col gap-3">
      <SectionHeader title="Browser" />
      <BrowsersPanel botId={botId} />
    </section>
  );
}
