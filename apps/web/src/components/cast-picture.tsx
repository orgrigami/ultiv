/**
 * The bot's browser as a moving picture, shared by the takeover (DRIVE: the
 * owner's pointer, finger and keys reach the page) and the watch view (the
 * picture only). Frames are decoded off the main thread into a canvas
 * (`createImageBitmap`), falling back to an image where that is missing.
 * The picture never scrolls the app (touch-action none while driving); a
 * popup the page opened is named on it; a dropped or ended view offers
 * Reopen.
 */
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { KeyboardIcon, PanelTopIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { KeyCatcher, summonKeys } from "@/components/takeover-key-catcher";
import { cn } from "@/lib/utils";
import type { CastFrameView, TakeoverCast } from "@/lib/takeover-cast";
import { useCastInput } from "@/lib/use-cast-input";

const CANVAS = typeof createImageBitmap === "function";

const bytesOf = (data: string): Uint8Array<ArrayBuffer> => {
  const raw = atob(data);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
};

/** Paint each new frame into the canvas, newest only. */
function useFrameCanvas(canvas: RefObject<HTMLCanvasElement | null>, frame: CastFrameView | null) {
  useEffect(() => {
    const el = canvas.current;
    if (!CANVAS || el === null || frame === null) return;
    let cancelled = false;
    void createImageBitmap(new Blob([bytesOf(frame.data)], { type: frame.mime }))
      .then((bitmap) => {
        if (!cancelled) {
          if (el.width !== bitmap.width) el.width = bitmap.width;
          if (el.height !== bitmap.height) el.height = bitmap.height;
          el.getContext("2d")?.drawImage(bitmap, 0, 0);
        }
        bitmap.close();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [canvas, frame]);
}

function Status({ cast }: { cast: TakeoverCast }) {
  if (cast.status !== "live" && (cast.frame === null || cast.status === "ended")) {
    return (
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
    );
  }
  return null;
}

export function CastPicture({
  cast,
  drive,
  keys,
  className,
  children,
}: {
  cast: TakeoverCast;
  drive: boolean;
  keys?: RefObject<HTMLTextAreaElement | null>;
  className?: string;
  /** Overlays the page is waiting on (a dialog, a file chooser). */
  children?: ReactNode;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const ownKeys = useRef<HTMLTextAreaElement | null>(null);
  const field = keys ?? ownKeys;
  useFrameCanvas(canvas, cast.frame);
  useCastInput(box, cast, () => summonKeys(field.current), drive);
  const frame = cast.frame;
  return (
    <div
      ref={box}
      className={cn(
        "bg-muted/40 has-[textarea:focus]:ring-ring relative w-full overflow-hidden rounded-lg border select-none has-[textarea:focus]:ring-2",
        drive && "cursor-pointer touch-none",
        className,
      )}
      style={{ aspectRatio: frame === null ? "16 / 10" : `${frame.w} / ${frame.h}` }}
    >
      {drive && <KeyCatcher cast={cast} ref={field} />}
      {frame !== null &&
        (CANVAS ? (
          <canvas
            ref={canvas}
            role="img"
            aria-label={frame.title === "" ? "The bot's browser" : frame.title}
            className="pointer-events-none block h-full w-full"
          />
        ) : (
          <img
            src={`data:${frame.mime};base64,${frame.data}`}
            alt={frame.title === "" ? "The bot's browser" : frame.title}
            draggable={false}
            className="pointer-events-none block h-full w-full"
          />
        ))}
      <Status cast={cast} />
      {frame?.popup === true && (
        <span className="bg-background/85 text-foreground pointer-events-none absolute top-2 left-2 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] backdrop-blur">
          <PanelTopIcon className="size-3" aria-hidden /> Popup window
        </span>
      )}
      {drive && frame !== null && cast.status === "live" && (
        <span className="text-muted-foreground bg-background/80 pointer-events-none absolute bottom-2 left-2 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] backdrop-blur">
          <KeyboardIcon className="size-3" aria-hidden />
          tap or click the page, then type — Escape releases the keys
        </span>
      )}
      {children}
    </div>
  );
}
