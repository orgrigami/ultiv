/**
 * Bot prose on the open transcript: markdown flows as terrain (no bubble)
 * at the chat size; while it streams, a caret sits at the end of the last
 * line (drawn in CSS, `.chat-prose[data-streaming]` in index.css). A
 * finished reply past the fold budget collapses behind a mask fade with a
 * "Show more" button — the fold is a reading aid, never a wall. Shared by the main chat and the rooms timeline.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { LazyMarkdown } from "@/components/lazy-markdown";

export const chatProse =
  "prose prose-sm chat-prose dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:my-1.5 [&_hr]:my-3 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5 [&_h1]:mt-3 [&_h2]:mt-3 [&_h3]:mt-2 [&_pre]:my-2 [&_code]:[overflow-wrap:anywhere]";

/** Past this much text a finished reply folds. */
const FOLD_CHARS = 1200;
const FOLD_LINES = 24;

export const isFoldable = (text: string): boolean =>
  text.length > FOLD_CHARS || text.split("\n").length > FOLD_LINES;

export function ChatProse({
  text,
  streaming = false,
  foldable = false,
}: {
  text: string;
  streaming?: boolean;
  /** The text qualifies for folding; the fold shows only when finished and unexpanded. */
  foldable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const fold = foldable && !streaming && !open;
  return (
    <>
      <div
        data-streaming={streaming || undefined}
        className={
          chatProse +
          " w-full min-w-0" +
          (fold
            ? " max-h-80 overflow-hidden [mask-image:linear-gradient(to_bottom,black_72%,transparent)]"
            : "")
        }
      >
        <LazyMarkdown text={text} />
      </div>
      {fold && (
        <Button variant="quiet" size="xs" className="mt-1" onClick={() => setOpen(true)}>
          Show more
        </Button>
      )}
      {open && text.length > FOLD_CHARS && (
        <Button variant="quiet" size="xs" className="mt-1" onClick={() => setOpen(false)}>
          Show less
        </Button>
      )}
    </>
  );
}
