/**
 * The pill composer: a round "+" (images, files, quick prompts) on the left,
 * the message box, and a round send arrow on the right (Stop joins it while
 * the bot works). Desktop: Enter sends, Shift+Enter is a newline. Touch:
 * Enter is a newline. While the bot works a send steers the running turn;
 * Alt+Enter (or the send button's long-press menu) holds it until the turn
 * finishes. With a draft mid-turn a "Redirect now" pill shows above the box.
 * Files stage as chips above the box and upload when the message sends;
 * pasted or dropped files stage too. On a text-only model a staged image
 * draws a muted note: images ride as file references instead.
 */
import type { SendMode } from "@ultiv/contracts";
import { CornerUpRightIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
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
        className="chrome-float focus-within:ring-ring/40 flex items-end gap-1.5 rounded-[1.75rem] p-1.5 focus-within:ring-2"
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
        <textarea
          aria-label="Message"
          placeholder={placeholder}
          value={draft}
          disabled={!live}
          rows={1}
          className="placeholder:text-muted-foreground field-sizing-content max-h-[40dvh] min-h-10 min-w-0 pointer-coarse:min-h-11 flex-1 resize-none overflow-y-auto bg-transparent px-1 py-2.5 text-base leading-snug outline-none disabled:opacity-60 md:text-sm"
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
            variant="outline"
            size="icon-lg"
            className="shrink-0 rounded-full text-signal"
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
          onSend={onSend}
        />
      </div>
      {sendFailed && (
        <div
          role="alert"
          className="chrome-float flex w-fit items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm"
        >
          <span className="text-signal">Not sent.</span>
          <Button type="submit" variant="link" size="xs" className="h-auto p-0">
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
        className="bg-background/70 h-11 gap-1.5 rounded-full px-4 shadow-sm backdrop-blur-md"
        title="Stop this reply at a safe point and answer your message instead (Ctrl/Cmd+Shift+Enter)"
        onClick={onRedirect}
      >
        <CornerUpRightIcon />
        Redirect now
      </Button>
    </div>
  );
}
