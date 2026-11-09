/**
 * One bot's browser session with no takeover open: where its page stands
 * and what it waits on (a dialog, a file, a popup on show), a WATCH-ONLY
 * live view on demand (the same cast a takeover drives, but nothing the
 * owner does reaches the page, and watching never resizes it), full screen
 * for a closer look, and Close — the session ends whichever of the bot's
 * conversations holds it (its sign-ins are kept).
 */
import { useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { EyeIcon, EyeOffIcon, GlobeIcon, Maximize2Icon, Minimize2Icon, XIcon } from "lucide-react";
import { BotAvatar } from "@/components/bot-avatar";
import { Button } from "@/components/ui/button";
import { CastPicture } from "@/components/cast-picture";
import { CastWaits, SavedDownloads } from "@/components/cast-overlays";
import { api, type BrowserSessionRow } from "@/lib/api";
import { formatWhen } from "@/lib/format";
import { useBrowserCast } from "@/lib/takeover-cast";
import { useBoxSize } from "@/lib/use-cast-input";

const hostOf = (url: string): string => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

function WatchView({
  row,
  full,
  onFull,
}: {
  row: BrowserSessionRow;
  full: boolean;
  onFull: (on: boolean) => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const size = useBoxSize(box);
  const cast = useBrowserCast({ kind: "watch", conversationId: row.conversationId }, size);
  const body = (
    <CastPicture cast={cast} drive={false}>
      <CastWaits cast={cast} drive={false} />
    </CastPicture>
  );
  return (
    <div ref={box} className="flex flex-col gap-2">
      {!full && body}
      <SavedDownloads cast={cast} botName={row.botName} />
      <DialogPrimitive.Root open={full} onOpenChange={onFull}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Popup
            aria-describedby={undefined}
            className="bg-background text-foreground fixed inset-0 z-[60] flex flex-col gap-2 p-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:p-4"
          >
            <div className="flex items-center gap-2">
              <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-sm font-medium">
                Watching {row.botName} · {row.title || hostOf(row.url)}
              </DialogPrimitive.Title>
              <DialogPrimitive.Close
                render={
                  <Button
                    variant="ghost"
                    size="icon-lg"
                    aria-label="Exit full screen"
                    title="Exit full screen (Esc)"
                  >
                    <Minimize2Icon />
                  </Button>
                }
              />
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center">{body}</div>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
}

/** What the page waits on, in a word. */
const waitsOn = (row: BrowserSessionRow): string | null => {
  if (row.dialog !== undefined && row.dialog !== null) return `waits on a dialog: ${row.dialog}`;
  if (row.chooser === true) return "waits for a file";
  if (row.popup === true) return "on a popup window";
  return null;
};

export function BrowserWatchCard({
  row,
  showBot,
  onClosed,
}: {
  row: BrowserSessionRow;
  /** The bot's name and face (the all-bots panel); a bot's own tab leaves them out. */
  showBot: boolean;
  onClosed: () => Promise<void>;
}) {
  const [watching, setWatching] = useState(false);
  const [full, setFull] = useState(false);
  const [closing, setClosing] = useState(false);
  const waits = waitsOn(row);
  const close = async (): Promise<void> => {
    setClosing(true);
    try {
      await api.browserSessionClose(row.conversationId);
      await onClosed();
    } finally {
      setClosing(false);
    }
  };
  return (
    <div className="bg-card flex flex-col gap-2 rounded-xl border p-3">
      <div className="flex flex-wrap items-center gap-3">
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
            {waits !== null ? ` · ${waits}` : ""}
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
        {watching && (
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Watch full screen"
            onClick={() => setFull(true)}
          >
            <Maximize2Icon />
          </Button>
        )}
        <Button variant="ghost" size="sm" disabled={closing} onClick={() => void close()}>
          <XIcon /> Close
        </Button>
      </div>
      {watching && <WatchView row={row} full={full} onFull={setFull} />}
    </div>
  );
}
