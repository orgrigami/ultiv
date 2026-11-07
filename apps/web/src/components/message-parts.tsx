/**
 * The pieces every bot message shares, in the chat and in bot talks: the
 * turn head (face, name, clock) and the one action row under a finished
 * message (a status such as "Interrupted" or a delivery note, then copy).
 * The row keeps its height whether or not its buttons show, so hovering
 * never shifts the transcript; copy reveals on hover or focus and stays
 * visible on touch screens, where there is no hover.
 */
import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { BotAvatar, type AvatarMood } from "@/components/bot-avatar";
import { Button } from "@/components/ui/button";
import { writeClipboard } from "@/lib/clipboard";
import { formatClock } from "@/lib/format";
import { cn } from "@/lib/utils";

/** A turn begins: the speaker's face and name, and when they spoke. */
export function TurnHead({
  id,
  name,
  at,
  mood = "idle",
  className,
}: {
  id?: string | undefined;
  name: string;
  at?: number | undefined;
  mood?: AvatarMood;
  className?: string;
}) {
  return (
    <div
      data-slot="turn-head"
      className={cn("text-muted-foreground flex items-center gap-2 text-sm", className)}
    >
      <BotAvatar id={id} name={name} size="sm" mood={mood} />
      <span className="text-foreground/80 font-medium">{name}</span>
      {at !== undefined && (
        <time className="readout text-muted-foreground/80" dateTime={new Date(at).toISOString()}>
          {formatClock(at)}
        </time>
      )}
    </div>
  );
}

/** Copies one message; the icon turns into a tick for two seconds. */
function CopyMessage({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [copied]);
  return (
    <>
      <Button
        type="button"
        variant="quiet"
        size="icon-sm"
        aria-label={copied ? "Copied" : label}
        title={copied ? "Copied" : "Copy"}
        className="opacity-0 group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 data-[copied]:opacity-100"
        data-copied={copied || undefined}
        onClick={() => {
          writeClipboard(text)
            .then(() => setCopied(true))
            .catch(() => {});
        }}
      >
        {copied ? <CheckIcon className="text-ok" /> : <CopyIcon />}
      </Button>
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </>
  );
}

/**
 * The row under a finished message: a status first (it reads as part of the
 * message, so it lines up with the text), then copy. The copy icon lines up
 * with the text's left edge when it leads (the negative margin takes back the
 * button's padding). A detail (a reason) wraps onto its own line below.
 */
export function MessageActions({
  text,
  label = "Copy message",
  status,
  detail,
  extra,
}: {
  /** What copy puts on the clipboard; empty hides the copy button. */
  text: string;
  label?: string;
  status?: React.ReactNode;
  detail?: React.ReactNode;
  /** More actions after copy (e.g. continue from here in a new chat). */
  extra?: React.ReactNode;
}) {
  return (
    <div
      data-slot="message-actions"
      className="text-muted-foreground -ms-1.5 flex min-h-7 flex-wrap items-center gap-x-1 text-xs"
    >
      {status !== undefined && status !== null && status !== false && (
        <span className="ps-1.5">{status}</span>
      )}
      {text !== "" && <CopyMessage text={text} label={label} />}
      {extra}
      {detail !== undefined && detail !== null && detail !== false && (
        <p className="w-full ps-1.5 pb-1 break-words">{detail}</p>
      )}
    </div>
  );
}
