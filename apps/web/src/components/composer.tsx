/**
 * The pill composer: a round "+" (quick prompts) on the left, the message box,
 * and a round send arrow on the right (Stop joins it while the bot works).
 * Desktop: Enter sends, Shift+Enter is a newline. Touch: Enter is a newline.
 * While the bot works a send steers the running turn; Alt+Enter (or the send
 * button's long-press menu) holds it until the turn finishes. With a draft
 * mid-turn a "Redirect now" pill shows above the box (also Ctrl/Cmd+Shift+Enter
 * and the menu): it stops the reply at a safe point and answers the draft.
 */
import { Popover } from "@base-ui/react/popover";
import type { SendMode } from "@ultiv/contracts";
import { CornerUpRightIcon, PlusIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { canSend, SendButton } from "@/components/send-button";
import { canRedirect, keySendMode } from "../lib/send-mode.ts";

/** Starter prompts: the "+" menu and the empty chat both offer them. */
export const SUGGESTIONS = [
  "What can you do for me?",
  "What do you remember about me?",
  "Help me plan my day",
  "Remind me tomorrow at 9am to check my email",
] as const;

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
}) {
  const round = "shrink-0 rounded-full";
  const placeholder = !live
    ? "Waiting for link…"
    : botName !== undefined && botName !== ""
      ? `Ask ${botName}`
      : "Ask anything";
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
      {/* Translucent and blurred: the transcript scrolls underneath it. */}
      <div className="chrome-float focus-within:ring-ring/40 flex items-end gap-1.5 rounded-[1.75rem] p-1.5 focus-within:ring-2">
        <Popover.Root>
          <Popover.Trigger
            disabled={!live}
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-lg"
                className={`${round} bg-muted/70`}
                aria-label="Quick prompts"
              >
                <PlusIcon />
              </Button>
            }
          />
          <Popover.Portal>
            <Popover.Positioner side="top" align="start" sideOffset={8} className="z-50">
              <Popover.Popup className="bg-popover text-popover-foreground flex w-72 max-w-[calc(100vw-1.5rem)] flex-col rounded-xl border p-1 shadow-lg outline-none">
                {SUGGESTIONS.map((text) => (
                  <Popover.Close
                    key={text}
                    render={
                      <Button
                        variant="ghost"
                        className="h-auto justify-start py-2 text-left whitespace-normal"
                      />
                    }
                    onClick={() => onDraft(text)}
                  >
                    {text}
                  </Popover.Close>
                ))}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
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
            className={`${round} text-signal`}
            aria-label="Stop"
            title="Stop"
            disabled={!live}
            onClick={onStop}
          >
            <SquareIcon className="fill-current" />
          </Button>
        )}
        <SendButton busy={busy} enabled={canSend(live, sending, draft)} onSend={onSend} />
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
