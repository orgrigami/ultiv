/**
 * The driving seat's controls over the live picture: the address bar (Go,
 * Back, Reload), the phone keyboard, Paste (a password or code from the
 * clipboard, typed into the page), Copy (the text selected on the page, to
 * your clipboard), Esc for the page (Escape itself leaves full screen) and
 * full screen. The countdown shows how long the ask stays
 * open; Extend restarts it (never past two hours from the ask).
 */
import { useEffect, useState, type RefObject } from "react";
import {
  ArrowLeftIcon,
  ClipboardCopyIcon,
  ClipboardPasteIcon,
  KeyboardIcon,
  Maximize2Icon,
  Minimize2Icon,
  RotateCwIcon,
  TimerIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { summonKeys } from "@/components/takeover-key-catcher";
import { textActs } from "@/lib/cast-keys";
import type { TakeoverCast } from "@/lib/takeover-cast";

/** The address bar: the owner's draft wins only while they edit it. */
export function UrlBar({ cast, onNavigated }: { cast: TakeoverCast; onNavigated: () => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const go = (): void => {
    const url = (draft ?? cast.frame?.url ?? "").trim();
    if (url === "" || cast.frame === null) return;
    cast.send({ a: "nav", url: /^[a-z]+:/i.test(url) ? url : `https://${url}` });
    setDraft(null);
    onNavigated();
  };
  const off = cast.frame === null;
  return (
    <div className="flex gap-1.5">
      <Button
        variant="outline"
        size="icon-sm"
        aria-label="Back"
        disabled={off}
        onClick={() => cast.send({ a: "back" })}
      >
        <ArrowLeftIcon />
      </Button>
      <Input
        aria-label="Page address"
        className="text-muted-foreground font-mono text-xs"
        value={draft ?? cast.frame?.url ?? ""}
        disabled={off}
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
        disabled={off}
        // Keep focus in the url bar: its blur drops the draft Go is about to send.
        onMouseDown={(event) => event.preventDefault()}
        onClick={go}
      >
        Go
      </Button>
      <Button
        variant="outline"
        size="icon-sm"
        aria-label="Reload the page"
        disabled={off}
        onClick={() => cast.send({ a: "reload" })}
      >
        <RotateCwIcon />
      </Button>
    </div>
  );
}

const minutesLeft = (ms: number): string => {
  if (ms <= 60_000) return `${Math.max(0, Math.ceil(ms / 1000))} s left`;
  return `${Math.ceil(ms / 60_000)} min left`;
};

/** Time left on the ask, ticking once a second (a local clock, never the server). */
export function Countdown({
  deadline,
  onExtend,
}: {
  deadline: number;
  onExtend: () => Promise<void>;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const left = deadline - now;
  const soon = left < 5 * 60_000;
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={
          soon
            ? "text-signal flex items-center gap-1 text-xs"
            : "text-muted-foreground flex items-center gap-1 text-xs"
        }
      >
        <TimerIcon className="size-3.5" aria-hidden />
        {minutesLeft(left)}
      </span>
      {left < 10 * 60_000 && (
        <Button
          variant="outline"
          size="xs"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onExtend().finally(() => setBusy(false));
          }}
        >
          Extend
        </Button>
      )}
    </span>
  );
}

/** Keyboard, Paste, Esc and full screen. */
export function DriveTools({
  cast,
  keys,
  full,
  onFull,
}: {
  cast: TakeoverCast;
  keys: RefObject<HTMLTextAreaElement | null>;
  full: boolean;
  onFull: (on: boolean) => void;
}) {
  const [pasteProblem, setPasteProblem] = useState<string | null>(null);
  const paste = async (): Promise<void> => {
    try {
      const text = await navigator.clipboard.readText();
      for (const act of textActs(text)) cast.send(act);
      setPasteProblem(null);
    } catch {
      setPasteProblem("The browser kept the clipboard to itself: tap the page, then paste there.");
    }
  };
  const off = cast.frame === null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button variant="outline" size="sm" disabled={off} onClick={() => summonKeys(keys.current)}>
        <KeyboardIcon /> Keyboard
      </Button>
      <Button variant="outline" size="sm" disabled={off} onClick={() => void paste()}>
        <ClipboardPasteIcon /> Paste
      </Button>
      <Button variant="outline" size="sm" disabled={off} onClick={() => cast.send({ a: "copy" })}>
        <ClipboardCopyIcon /> Copy
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={off}
        onClick={() => cast.send({ a: "key", key: "Escape" })}
      >
        Esc
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="ml-auto"
        aria-pressed={full}
        onClick={() => onFull(!full)}
      >
        {full ? <Minimize2Icon /> : <Maximize2Icon />}
        {full ? "Exit full screen" : "Full screen"}
      </Button>
      {pasteProblem !== null && (
        <span className="text-muted-foreground w-full text-xs">{pasteProblem}</span>
      )}
    </div>
  );
}

/**
 * Text copied out of the page lands on the clipboard; where the browser keeps
 * the clipboard to itself (no tap to vouch for the write), it shows here with
 * its own Copy button, which is a tap.
 */
export function CopiedText({ cast }: { cast: TakeoverCast }) {
  const [shown, setShown] = useState<string | null>(null);
  const copied = cast.copied;
  useEffect(() => {
    if (copied === null) return;
    if (copied.text === "") {
      setShown("");
      return;
    }
    navigator.clipboard
      .writeText(copied.text)
      .then(() => setShown(null))
      .catch(() => setShown(copied.text));
  }, [copied]);
  if (copied === null || shown === null) return null;
  if (shown === "") {
    return (
      <p className="text-muted-foreground text-xs">
        Nothing is selected on the page: drag across the text (or double-tap a word), then Copy.
      </p>
    );
  }
  return (
    <div className="bg-muted/40 flex items-start gap-2 rounded-lg border p-2 text-xs">
      <span className="min-w-0 flex-1 break-words">{shown.slice(0, 500)}</span>
      <Button
        variant="outline"
        size="xs"
        onClick={() =>
          void navigator.clipboard
            .writeText(shown)
            .then(() => setShown(null))
            .catch(() => undefined)
        }
      >
        Copy
      </Button>
    </div>
  );
}
