/**
 * The live takeover card: the bot's browser as a moving picture the owner
 * DRIVES. Clicks and taps land where they land on a real screen, drags
 * select and slide, a swipe scrolls, typing goes to the focused field (the
 * phone keyboard opens from a tap; Paste brings a password or a code from
 * the clipboard), the url bar navigates — real input events on the bot's
 * chromium, streaming back as frames sized to the picture. Page dialogs and
 * file choosers are answered over the picture; downloads land in the bot's
 * files. Full screen gives the page the whole screen (a phone gets the
 * page's phone layout) and hands the window back on exit. Finish hands the
 * controls back (the bot's waiting call gets the page); Step away drops the
 * hold; Extend gives more time.
 */
import { useEffect, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { GlobeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { CastPicture } from "@/components/cast-picture";
import { CastWaits, SavedDownloads } from "@/components/cast-overlays";
import { CopiedText, Countdown, DriveTools, UrlBar } from "@/components/takeover-toolbar";
import { summonKeys } from "@/components/takeover-key-catcher";
import { useTakeoverCast, type TakeoverCast } from "@/lib/takeover-cast";
import { useBoxSize } from "@/lib/use-cast-input";
import { api } from "@/lib/api";
import type { TakeoverAsk } from "@/lib/use-browsers";

/** The page's window: the owner's screen in full screen, the bot's default otherwise. */
const fitViewport = (cast: TakeoverCast, full: boolean): void => {
  if (!full) {
    cast.send({ a: "viewport", w: 1280, h: 800, mobile: false });
    return;
  }
  const w = Math.max(320, Math.min(1920, window.innerWidth));
  const h = Math.max(320, Math.min(1600, window.innerHeight - 140));
  cast.send({ a: "viewport", w, h, mobile: w < 640 });
};

function DriveBody({
  cast,
  row,
  full,
  onFull,
}: {
  cast: TakeoverCast;
  row: TakeoverAsk;
  full: boolean;
  onFull: (on: boolean) => void;
}) {
  const keys = useRef<HTMLTextAreaElement | null>(null);
  return (
    <>
      <UrlBar cast={cast} onNavigated={() => summonKeys(keys.current)} />
      <DriveTools cast={cast} keys={keys} full={full} onFull={onFull} />
      <CastPicture
        cast={cast}
        drive
        keys={keys}
        {...(full ? { className: "max-h-full self-center" } : {})}
      >
        <CastWaits cast={cast} drive />
      </CastPicture>
      <CopiedText cast={cast} />
      {cast.error !== null && <ErrorState message={cast.error} onRetry={cast.dismissError} />}
      <SavedDownloads cast={cast} botName={row.botName} />
    </>
  );
}

function Header({
  row,
  cast,
  onExtend,
}: {
  row: TakeoverAsk;
  cast: TakeoverCast;
  onExtend: () => Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex items-center gap-2">
        <GlobeIcon className="text-muted-foreground size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          <strong>{row.botName}</strong> asked you to take the controls
        </span>
        <span
          className={
            cast.status === "live"
              ? "bg-ok/15 text-ok flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs"
              : "text-muted-foreground bg-muted shrink-0 rounded-full px-2 py-0.5 text-xs"
          }
        >
          {cast.status === "live" ? "Live" : cast.status === "connecting" ? "Connecting…" : "Ended"}
        </span>
      </div>
      {/* The reason and the clock on their own line: a phone keeps the title whole. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-6">
        <span className="text-muted-foreground min-w-0 flex-1 text-xs">{row.reason}</span>
        <Countdown deadline={row.deadline} onExtend={onExtend} />
      </div>
    </div>
  );
}

function Hands({ busy, onClose }: { busy: boolean; onClose: (how: "finish" | "cancel") => void }) {
  return (
    <div className="flex justify-end gap-2">
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => onClose("cancel")}>
        Step away
      </Button>
      <Button size="sm" disabled={busy} onClick={() => onClose("finish")}>
        {busy && <Spinner />}
        Finish and hand back
      </Button>
    </div>
  );
}

export function TakeoverLiveCard({
  row,
  onGone,
}: {
  row: TakeoverAsk;
  onGone: () => Promise<void>;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const size = useBoxSize(box);
  const cast = useTakeoverCast(row.id, size);
  const [busy, setBusy] = useState(false);
  const [full, setFull] = useState(false);
  const { resize } = cast;

  // A stream that ended may mean the ASK closed off-REST (its cap, a
  // stopped turn): refetch the list — the card unmounts if the row is gone.
  useEffect(() => {
    if (cast.status === "ended") void onGone();
  }, [cast.status, onGone]);
  useEffect(() => {
    if (size !== null && !full) resize(size.w, size.h);
  }, [size, full, resize]);

  const toggleFull = (on: boolean): void => {
    setFull(on);
    fitViewport(cast, on);
    if (on)
      resize(
        window.innerWidth * (window.devicePixelRatio || 1),
        window.innerHeight * (window.devicePixelRatio || 1),
      );
  };
  const close = async (how: "finish" | "cancel"): Promise<void> => {
    setBusy(true);
    try {
      if (how === "finish") await api.browserTakeoverFinish(row.id);
      else await api.browserTakeoverCancel(row.id);
      await onGone();
    } finally {
      setBusy(false);
    }
  };
  const extend = async (): Promise<void> => {
    await api.browserTakeoverExtend(row.id).catch(() => undefined);
    await onGone();
  };

  return (
    <div ref={box} className="bg-card flex flex-col gap-3 rounded-xl border p-3">
      <Header row={row} cast={cast} onExtend={extend} />
      {!full && <DriveBody cast={cast} row={row} full={false} onFull={toggleFull} />}
      {full && <p className="text-muted-foreground text-sm">The page is in full screen.</p>}
      <Hands busy={busy} onClose={(how) => void close(how)} />
      <DialogPrimitive.Root open={full} onOpenChange={toggleFull}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Popup
            aria-describedby={undefined}
            className="bg-background text-foreground fixed inset-0 z-[60] flex flex-col gap-2 overflow-auto p-2 pt-[max(0.5rem,env(safe-area-inset-top))] transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none sm:p-4"
          >
            <DialogPrimitive.Title className="sr-only">
              {row.botName}'s browser
            </DialogPrimitive.Title>
            <Header row={row} cast={cast} onExtend={extend} />
            <DriveBody cast={cast} row={row} full onFull={toggleFull} />
            <Hands busy={busy} onClose={(how) => void close(how)} />
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
}
