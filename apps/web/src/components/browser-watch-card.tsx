/**
 * One bot browser session with no takeover open: where its page stands, and
 * a WATCH-ONLY live view on demand (the same cast a takeover drives, but
 * nothing the owner does reaches the page — the bot is the one driving).
 * The view opens on a tap, not by itself: a cast is a process in the bot's
 * VM, and it pins the browser's window to 1280×800 while it runs.
 */
import { useState } from "react";
import { EyeIcon, EyeOffIcon, GlobeIcon } from "lucide-react";
import { BotAvatar } from "@/components/bot-avatar";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { BrowserSessionRow } from "@/lib/api";
import { formatWhen } from "@/lib/format";
import { useBrowserCast } from "@/lib/takeover-cast";

const hostOf = (url: string): string => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

function WatchView({ conversationId }: { conversationId: string }) {
  const cast = useBrowserCast({ kind: "watch", conversationId });
  return (
    <div
      role="img"
      aria-label={cast.frame?.title || "The bot's browser"}
      className="bg-muted/40 relative w-full overflow-hidden rounded-lg border"
      style={{
        aspectRatio: cast.frame === null ? "16 / 10" : `${cast.frame.w} / ${cast.frame.h}`,
      }}
    >
      {cast.frame !== null ? (
        <img
          src={`data:${cast.frame.mime};base64,${cast.frame.data}`}
          alt=""
          draggable={false}
          className="pointer-events-none block h-full w-full select-none"
        />
      ) : (
        <div className="text-muted-foreground absolute inset-0 grid place-items-center text-sm">
          {cast.status === "ended" ? (
            <span className="flex flex-col items-center gap-2">
              The view ended.
              <Button variant="outline" size="sm" onClick={cast.reopen}>
                Reopen
              </Button>
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <Spinner /> Opening the live view…
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function BrowserWatchCard({
  row,
  showBot,
}: {
  row: BrowserSessionRow;
  /** The bot's name and face (the all-bots panel); a bot's own tab leaves them out. */
  showBot: boolean;
}) {
  const [watching, setWatching] = useState(false);
  return (
    <div className="bg-card flex flex-col gap-2 rounded-xl border p-3">
      <div className="flex items-center gap-3">
        {showBot && row.profileId !== null ? (
          <BotAvatar id={row.profileId} name={row.botName} />
        ) : (
          <GlobeIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">
            {showBot ? `${row.botName} · ` : ""}
            {row.title || hostOf(row.url) || "A blank page"}
          </span>
          <span className="text-muted-foreground truncate text-xs">
            {row.url !== "" ? hostOf(row.url) : "no page yet"}
            {row.at > 0 ? ` · ${formatWhen(row.at)}` : ""}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          aria-pressed={watching}
          onClick={() => setWatching((on) => !on)}
        >
          {watching ? <EyeOffIcon /> : <EyeIcon />}
          {watching ? "Stop watching" : "Watch"}
        </Button>
      </div>
      {watching && <WatchView conversationId={row.conversationId} />}
    </div>
  );
}
