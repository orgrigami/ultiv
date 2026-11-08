/**
 * The live takeover card: the bot's browser as a moving picture the owner
 * DRIVES. Clicks land where they land on a real screen, typing goes to the
 * focused field, the wheel scrolls the page, the url bar navigates — real
 * input events on the bot's chromium, streaming back as frames. Finish
 * hands the controls back (the bot wakes with the page); Step away drops
 * the hold without waking it. The keyboard reaches the page only while the
 * picture holds focus: click it, then type; Escape gives focus back.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { GlobeIcon, KeyboardIcon, RotateCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { imagePoint, keyDecision, useTakeoverCast } from "@/lib/takeover-cast";
import { api } from "@/lib/api";

export interface TakeoverRowView {
  readonly id: string;
  readonly conversationId: string;
  readonly reason: string;
  readonly openedAt: number;
  readonly profileId: string | null;
  readonly botName: string;
}

export function TakeoverLiveCard({
  row,
  onGone,
}: {
  row: TakeoverRowView;
  onGone: () => Promise<void>;
}) {
  const cast = useTakeoverCast(row.id);
  const [busy, setBusy] = useState(false);
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const frameBox = useRef<HTMLDivElement | null>(null);

  // The url bar follows the page unless the owner is editing it.
  useEffect(() => {
    if (urlDraft === null && cast.frame !== null) setUrlDraft(cast.frame.url);
  }, [cast.frame, urlDraft]);

  const at = (event: MouseEvent): { x: number; y: number } => {
    const box = frameBox.current?.getBoundingClientRect();
    return box === undefined
      ? { x: 0, y: 0 }
      : { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const tap = (event: MouseEvent<HTMLDivElement>): void => {
    if (cast.frame === null) return;
    const box = frameBox.current?.getBoundingClientRect();
    const point = at(event);
    const scaled = box === undefined ? point : imagePoint(cast.frame, box.width, point);
    cast.send({ a: "tap", x: scaled.x, y: scaled.y, id: cast.frame.id });
  };

  // The wheel must not scroll the app behind the picture: a non-passive
  // listener (React's synthetic wheel is passive at the root).
  const send = cast.send;
  useEffect(() => {
    const box = frameBox.current;
    if (box === null || cast.status !== "live") return;
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
  }, [send, cast.status]);

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

  const go = (): void => {
    const url = (urlDraft ?? "").trim();
    if (url === "" || cast.frame === null) return;
    cast.send({ a: "nav", url });
    frameBox.current?.focus();
  };

  const finish = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.browserTakeoverFinish(row.id);
      await onGone();
    } finally {
      setBusy(false);
    }
  };

  const stepAway = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.browserTakeoverCancel(row.id);
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
              ? "flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-400"
              : "text-muted-foreground rounded-full bg-muted px-2 py-0.5 text-xs"
          }
        >
          {cast.status === "live" ? "Live" : cast.status === "connecting" ? "Connecting…" : "Ended"}
        </span>
      </div>

      <div className="flex gap-2">
        <Input
          aria-label="Page address"
          className="text-muted-foreground font-mono text-xs"
          placeholder={cast.frame?.url ?? ""}
          value={urlDraft ?? ""}
          disabled={cast.frame === null}
          onChange={(event) => setUrlDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              go();
            }
          }}
        />
        <Button variant="outline" size="sm" disabled={cast.frame === null} onClick={go}>
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

      <div
        ref={frameBox}
        role="img"
        aria-label={cast.frame?.title === "" ? "The bot's browser" : (cast.frame?.title ?? "")}
        tabIndex={0}
        onClick={tap}
        onKeyDown={onKeyDown}
        onBlur={() => cast.flush()}
        className="focus-visible:ring-ring relative w-full cursor-pointer overflow-hidden rounded-lg border outline-none focus-visible:ring-2"
        style={{
          aspectRatio: cast.frame === null ? "16 / 10" : `${cast.frame.w} / ${cast.frame.h}`,
        }}
      >
        {cast.frame !== null ? (
          <img
            src={`data:${cast.frame.mime};base64,${cast.frame.data}`}
            alt={cast.frame.title === "" ? "The page" : cast.frame.title}
            draggable={false}
            className="pointer-events-none block h-full w-full select-none"
          />
        ) : (
          <div className="text-muted-foreground absolute inset-0 grid place-items-center bg-muted/40 text-sm">
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
        {cast.frame !== null && (
          <div className="text-muted-foreground pointer-events-none absolute bottom-2 left-2 flex items-center gap-1 rounded-md bg-background/80 px-1.5 py-0.5 text-[10px] backdrop-blur">
            <KeyboardIcon className="size-3" />
            click the page, then type — Escape releases the keys
          </div>
        )}
      </div>

      {cast.error !== null && <ErrorState message={cast.error} onRetry={cast.dismissError} />}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void stepAway()}>
          Step away
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void finish()}>
          {busy && <Spinner />}
          Finish and hand back
        </Button>
      </div>
    </div>
  );
}
