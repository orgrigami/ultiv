/**
 * The live takeover card: the bot's browser as a moving picture the owner
 * DRIVES. Clicks land where they land on a real screen, typing goes to the
 * focused field, the wheel scrolls the page, the url bar navigates — real
 * input events on the bot's chromium, streaming back as frames. Finish
 * hands the controls back (the bot's waiting call gets the page); Step away
 * drops the hold (the call learns you stepped away). The keyboard reaches
 * the page only while the picture holds focus: click it, then type; Escape
 * gives focus back.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { GlobeIcon, KeyboardIcon, RotateCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { imagePoint, keyDecision, useTakeoverCast, type TakeoverCast } from "@/lib/takeover-cast";
import { api } from "@/lib/api";
import type { TakeoverAsk } from "@/lib/use-browsers";

/**
 * The address bar: it shows the page's url; the owner's draft wins only
 * while they edit it (null = not editing), so a link they click updates it.
 */
function UrlBar({ cast, onNavigated }: { cast: TakeoverCast; onNavigated: () => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const go = (): void => {
    const url = (draft ?? cast.frame?.url ?? "").trim();
    if (url === "" || cast.frame === null) return;
    cast.send({ a: "nav", url });
    setDraft(null);
    onNavigated();
  };
  return (
    <div className="flex gap-2">
      <Input
        aria-label="Page address"
        className="text-muted-foreground font-mono text-xs"
        value={draft ?? cast.frame?.url ?? ""}
        disabled={cast.frame === null}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => setDraft(null)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            go();
          } else if (event.key === "Escape" && draft !== null) {
            // Escape abandons the edit; it must not also close the dock.
            event.preventDefault();
            setDraft(null);
          }
        }}
      />
      <Button
        variant="outline"
        size="sm"
        disabled={cast.frame === null}
        // Keep focus in the url bar: its blur drops the draft Go is about to send.
        onMouseDown={(event) => event.preventDefault()}
        onClick={go}
      >
        Go
      </Button>
      <Button
        variant="outline"
        size="sm"
        aria-label="Reload the page"
        disabled={cast.frame === null}
        onClick={() => cast.send({ a: "reload" })}
      >
        <RotateCwIcon />
      </Button>
    </div>
  );
}

/** The picture the owner points and types at; taps map to the frame's own pixels. */
function LivePicture({
  cast,
  frameBox,
}: {
  cast: TakeoverCast;
  frameBox: React.RefObject<HTMLDivElement | null>;
}) {
  const tap = (event: MouseEvent<HTMLDivElement>): void => {
    const box = frameBox.current?.getBoundingClientRect();
    if (cast.frame === null || box === undefined) return;
    const point = { x: event.clientX - box.left, y: event.clientY - box.top };
    const scaled = imagePoint(cast.frame, box.width, point);
    cast.send({ a: "tap", x: scaled.x, y: scaled.y, id: cast.frame.id });
  };

  // The wheel must not scroll the app behind the picture: a non-passive
  // listener (React's synthetic wheel is passive at the root).
  const { send, status } = cast;
  useEffect(() => {
    const box = frameBox.current;
    if (box === null || status !== "live") return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      send({
        a: "scroll",
        dx: Math.max(-3000, Math.min(3000, event.deltaX)),
        dy: Math.max(-3000, Math.min(3000, event.deltaY)),
      });
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, [send, status, frameBox]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const decision = keyDecision(event);
    if (decision.send === "passthrough") return;
    event.preventDefault();
    if (decision.send === "escape") {
      cast.flush();
      frameBox.current?.blur();
      return;
    }
    if (decision.send === "key") cast.send({ a: "key", key: decision.key });
    else cast.send({ a: "type", text: decision.text });
  };

  const frame = cast.frame;
  return (
    <div
      ref={frameBox}
      role="img"
      aria-label={frame === null || frame.title === "" ? "The bot's browser" : frame.title}
      tabIndex={0}
      onClick={tap}
      onKeyDown={onKeyDown}
      onBlur={() => cast.flush()}
      className="focus-visible:ring-ring relative w-full cursor-pointer overflow-hidden rounded-lg border outline-none focus-visible:ring-2"
      style={{ aspectRatio: frame === null ? "16 / 10" : `${frame.w} / ${frame.h}` }}
    >
      {frame !== null && (
        <img
          src={`data:${frame.mime};base64,${frame.data}`}
          alt={frame.title === "" ? "The page" : frame.title}
          draggable={false}
          className="pointer-events-none block h-full w-full select-none"
        />
      )}
      {cast.status !== "live" && (frame === null || cast.status === "ended") && (
        // Over a frozen last frame too: an ended view always offers Reopen.
        <div className="text-muted-foreground bg-muted/70 absolute inset-0 grid place-items-center text-sm">
          {cast.status === "connecting" ? (
            <span className="flex items-center gap-2">
              <Spinner /> Opening the live view…
            </span>
          ) : (
            <span className="flex flex-col items-center gap-2">
              The view ended.
              <Button variant="outline" size="sm" onClick={cast.reopen}>
                Reopen
              </Button>
            </span>
          )}
        </div>
      )}
      {frame !== null && cast.status === "live" && (
        <div className="text-muted-foreground bg-background/80 pointer-events-none absolute bottom-2 left-2 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] backdrop-blur">
          <KeyboardIcon className="size-3" />
          click the page, then type — Escape releases the keys
        </div>
      )}
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
  const cast = useTakeoverCast(row.id);
  const [busy, setBusy] = useState(false);
  const frameBox = useRef<HTMLDivElement | null>(null);

  // A stream that ended may mean the ASK closed off-REST (its cap, a
  // stopped turn): refetch the list — the card unmounts if the row is gone;
  // if the row lives, the picture offers Reopen.
  useEffect(() => {
    if (cast.status === "ended") void onGone();
  }, [cast.status, onGone]);

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

  return (
    <div className="bg-card flex flex-col gap-3 rounded-xl border p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <GlobeIcon className="text-muted-foreground size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          <strong>{row.botName}</strong> asked you to take the controls
        </span>
        <span className="text-muted-foreground text-xs">{row.reason}</span>
        <span
          className={
            cast.status === "live"
              ? "bg-ok/15 text-ok flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
              : "text-muted-foreground bg-muted rounded-full px-2 py-0.5 text-xs"
          }
        >
          {cast.status === "live" ? "Live" : cast.status === "connecting" ? "Connecting…" : "Ended"}
        </span>
      </div>
      <UrlBar cast={cast} onNavigated={() => frameBox.current?.focus()} />
      <LivePicture cast={cast} frameBox={frameBox} />
      {cast.error !== null && <ErrorState message={cast.error} onRetry={cast.dismissError} />}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void close("cancel")}>
          Step away
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void close("finish")}>
          {busy && <Spinner />}
          Finish and hand back
        </Button>
      </div>
    </div>
  );
}
