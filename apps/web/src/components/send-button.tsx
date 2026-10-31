/**
 * The composer's round send arrow. While the bot works a send joins the
 * running turn at its next step; long-press (touch) or right-click opens a
 * small menu that can hold the message until the turn finishes, or Redirect
 * now: stop the reply at a safe point and answer this message instead.
 */
import { useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import type { SendMode } from "@ultiv/contracts";
import { ArrowUpIcon } from "lucide-react";
import { SEND_CHOICES } from "../lib/send-mode.ts";
import { Button } from "./ui/button.tsx";

const LONG_PRESS_MS = 500;

/** Whether Send is usable: busy no longer blocks it — only the link, an in-flight send, or an empty message (no draft, no attachments). */
export function canSend(
  live: boolean,
  sending: boolean,
  draft: string,
  hasAttachments = false,
): boolean {
  return live && !sending && (draft.trim() !== "" || hasAttachments);
}

export function SendButton({
  busy,
  enabled,
  sending = false,
  onSend,
}: {
  busy: boolean;
  enabled: boolean;
  /** A send is in flight: the arrow lifts until the server has it. */
  sending?: boolean;
  onSend: (mode?: SendMode) => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The click that ends a long-press must not also send.
  const pressed = useRef(false);
  const [open, setOpen] = useState(false);
  const menu = busy && enabled;
  const cancelPress = () => clearTimeout(timer.current);
  const pick = (mode: SendMode) => {
    setOpen(false);
    onSend(mode);
  };
  return (
    <Popover.Root open={open && menu} onOpenChange={setOpen}>
      <Button
        ref={anchor}
        type="submit"
        size="icon-lg"
        className="send-btn shrink-0 rounded-full select-none [-webkit-touch-callout:none]"
        aria-label="Send"
        aria-busy={sending || undefined}
        aria-haspopup={menu ? "menu" : undefined}
        title={
          busy
            ? "Send: joins at the next step. Long-press or right-click for more (send after, redirect now)"
            : "Send"
        }
        disabled={!enabled}
        onPointerDown={() => {
          pressed.current = false;
          if (!menu) return;
          cancelPress();
          timer.current = setTimeout(() => {
            pressed.current = true;
            setOpen(true);
          }, LONG_PRESS_MS);
        }}
        onPointerUp={cancelPress}
        onPointerLeave={cancelPress}
        onPointerCancel={cancelPress}
        onContextMenu={(event) => {
          if (!menu) return;
          event.preventDefault();
          cancelPress();
          pressed.current = true;
          setOpen(true);
        }}
        onClick={(event) => {
          if (!pressed.current) return;
          pressed.current = false;
          event.preventDefault();
        }}
      >
        <ArrowUpIcon />
      </Button>
      <Popover.Portal>
        <Popover.Positioner anchor={anchor} side="top" align="end" sideOffset={8} className="z-50">
          <Popover.Popup className="bg-popover text-popover-foreground flex w-72 max-w-[calc(100vw-1.5rem)] flex-col rounded-xl border p-1 shadow-lg outline-none">
            {SEND_CHOICES.map((choice) => (
              <Button
                key={choice.mode}
                variant="ghost"
                className={`h-auto min-h-11 flex-col items-start justify-center gap-0 py-2 text-left whitespace-normal ${choice.mode === "redirect" ? "text-destructive" : ""}`}
                onClick={() => pick(choice.mode)}
              >
                <span>{choice.label}</span>
                <span className="text-muted-foreground text-xs font-normal">{choice.hint}</span>
              </Button>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
