/**
 * The composer: a pill at one line, a 3xl squircle once the draft grows past
 * it (continuous corners where the engine has corner-shape, plain radius
 * where it doesn't). A round "+" (images, files, quick prompts) on the left,
 * the message box, and a round send arrow on the right (Stop joins it while
 * the bot works). Desktop: Enter sends, Shift+Enter is a newline. Touch:
 * Enter is a newline. While the bot works a send steers the running turn;
 * Alt+Enter (or the send button's long-press menu) holds it until the turn
 * finishes. With a draft mid-turn a "Redirect now" pill shows above the box.
 * Files stage as chips above the box and upload when the message sends;
 * pasted or dropped files stage too. On a text-only model a staged image
 * draws a muted note: images ride as file references instead.
 */
import * as React from "react";
import type { SendMode } from "@spriessen/contracts";
import { CornerUpRightIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { canSend, SendButton } from "@/components/send-button";
import { isImageMime } from "@/lib/attachments";
import { PlusMenu, StagedChips, type Staged } from "@/components/composer-attachments";
import { canRedirect, keySendMode } from "../lib/send-mode.ts";

/** Starter prompts live with the plus menu now; re-exported for the empty chat. */
export { SUGGESTIONS } from "./composer-attachments.tsx";

const coarsePointer = (): boolean =>
  typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

export function Composer({
  botName,
  live,
  busy,
  sending,
  sendFailed,
  draft,
  onDraft,
  onSend,
  onStop,
  staged,
  onAttach,
  onRemoveStaged,
  vision,
}: {
  botName: string | undefined;
  live: boolean;
  busy: boolean;
  sending: boolean;
  sendFailed: boolean;
  draft: string;
  onDraft: (text: string) => void;
  onSend: (mode?: SendMode) => void;
  onStop: () => void;
  staged: readonly Staged[];
  onAttach: (files: FileList | File[]) => void;
  onRemoveStaged: (key: string) => void;
  vision: boolean | undefined;
}) {
  // The box is a pill at one line and relaxes to a 3xl squircle once the
  // draft grows past it — a stadium cap on a tall box eats the layout.
  // Measured, not inferred: the bare textarea auto-grows (field-sizing),
  // so the rendered height is the truth in every engine.
  const boxRef = React.useRef<HTMLDivElement>(null);
  const [grown, setGrown] = React.useState(false);
  React.useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    // One line tops out at 56px (6px padding + 44px touch-min textarea); a
    // second line clears 60. Observe, so font-size media changes also apply.
    const watch = () => setGrown(el.offsetHeight > 60);
    watch();
    const observer = new ResizeObserver(watch);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const placeholder = !live
    ? "Waiting for the server…"
    : botName !== undefined && botName !== ""
      ? `Ask ${botName}`
      : "Ask anything";
  const imageStaged = staged.some((item) => isImageMime(item.file.type));
  return (
    <form
      className="flex w-full flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
    >
      {canRedirect(busy, live, sending, draft) && (
        <RedirectPill onRedirect={() => onSend("redirect")} />
      )}
      <StagedChips staged={staged} onRemove={onRemoveStaged} />
      {vision === false && imageStaged && (
        <p className="text-muted-foreground px-2 text-xs">
          This model may not see images. They'll be sent as file references.
        </p>
      )}
      <div
        ref={boxRef}
        className="chrome-float focus-within:ring-ring/40 flex items-end gap-1.5 p-1.5 focus-within:ring-2 transition-[border-radius] duration-200 ease-out motion-reduce:transition-none"
        style={
          {
            borderRadius: grown ? "var(--radius-3xl)" : "9999px",
            cornerShape: "squircle",
          } as React.CSSProperties
        }
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files);
          if (files.length === 0) return;
          event.preventDefault();
          onAttach(files);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          const files = Array.from(event.dataTransfer.files);
          if (files.length === 0) return;
          event.preventDefault();
          onAttach(files);
        }}
      >
        <PlusMenu disabled={!live} onAdd={onAttach} onDraft={onDraft} />
        <Textarea
          variant="bare"
          aria-label="Message"
          placeholder={placeholder}
          value={draft}
          disabled={!live}
          rows={1}
          className="max-h-[40dvh] min-w-0 flex-1 resize-none overflow-y-auto disabled:opacity-60"
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || coarsePointer()) return;
            const mode = keySendMode(event, busy);
            if (event.shiftKey && mode !== "redirect") return;
            event.preventDefault();
            onSend(mode);
          }}
        />
        {busy && (
          <Button
            type="button"
            variant="signal"
            size="icon-lg"
            pill
            className="working-ring shrink-0"
            aria-label="Stop"
            title="Stop"
            disabled={!live}
            onClick={onStop}
          >
            <SquareIcon className="fill-current" />
          </Button>
        )}
        <SendButton
          busy={busy}
          enabled={canSend(live, sending, draft, staged.length > 0)}
          sending={sending}
          onSend={onSend}
        />
      </div>
      {sendFailed && (
        <div
          role="alert"
          className="chrome-float flex w-fit items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm"
        >
          <span className="text-signal">Not sent.</span>
          <Button type="submit" variant="link" size="inline">
            Retry
          </Button>
        </div>
      )}
    </form>
  );
}

/** The obvious touch target for Redirect now (44px tall), right-aligned above the box. */
function RedirectPill({ onRedirect }: { onRedirect: () => void }) {
  return (
    <div className="flex justify-end">
      <Button
        type="button"
        variant="outline"
        size="xl"
        pill
        className="chrome-float"
        title="Stop this reply at a safe point and answer your message instead (Ctrl/Cmd+Shift+Enter)"
        onClick={onRedirect}
      >
        <CornerUpRightIcon />
        Redirect now
      </Button>
    </div>
  );
}
