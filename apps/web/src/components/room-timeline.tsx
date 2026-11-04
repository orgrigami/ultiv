/**
 * A bot-to-bot room as the house transcript, READ-ONLY: bots write here, the
 * owner reads along (no composer, no cancel). Bot prose is the terrain (no
 * bubble, no side alignment); each turn is headed by its speaker's drawn
 * character, name and clock, and a speaker's follow-up within a few minutes
 * continues under the same head; day dividers between. Grouping and divider
 * rules live in `lib/room-turns.ts`. It refetches on the live "mailbox"
 * signal and follows new messages while scrolled to the end. Lives under the
 * room header on /rooms and in the work pane (opened from a mail pill).
 */
import { Fragment, useEffect, useRef } from "react";
import { CircleAlertIcon } from "lucide-react";
import { ChatProse, isFoldable } from "@/components/chat-prose";
import { ErrorState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { api, type RoomLine } from "@/lib/api";
import { formatFull } from "@/lib/format";
import { MessageActions, TurnHead } from "@/components/message-parts";
import { deliveryNote } from "@/lib/room-status";
import { seatLines, type SeatedLine } from "@/lib/room-turns";
import { useLiveLoad } from "@/lib/use-live-load";
import { cn } from "@/lib/utils";
import { enter } from "@/components/system/card-shell";

/** Delivery state beside the copy button, with the recorded reason under it when it adds one. */
function Delivery({ line }: { line: RoomLine }) {
  const note = deliveryNote(line);
  return (
    <MessageActions
      text={line.text}
      status={
        note !== null && (
          <span
            className={cn(
              "inline-flex items-center gap-1.5",
              note.tone === "error" && "text-destructive",
            )}
          >
            {note.tone === "error" && <CircleAlertIcon className="size-3 shrink-0" aria-hidden />}
            {note.label}
          </span>
        )
      }
      detail={note?.reason}
    />
  );
}

function RoomTurn({ seated }: { seated: SeatedLine }) {
  const { line, grouped } = seated;
  if (line.system)
    return (
      <li className={cn("text-muted-foreground w-full py-1 text-center text-xs", enter)}>
        {line.text}
      </li>
    );
  return (
    <li
      className={cn(
        "group/msg flex w-full min-w-0 flex-col items-start gap-0.5",
        grouped ? "-mt-3" : "pt-2",
        enter,
      )}
      title={formatFull(line.at)}
    >
      {!grouped && (
        <TurnHead id={line.speakerId} name={line.speaker} at={line.at} className="mb-1" />
      )}
      <ChatProse text={line.text} foldable={isFoldable(line.text)} />
      <Delivery line={line} />
    </li>
  );
}

const DayDivider = ({ label }: { label: string }) => (
  <li role="separator" className="text-muted-foreground/70 flex items-center gap-3 py-1">
    <span className="bg-border h-px flex-1" />
    <span className="readout">{label}</span>
    <span className="bg-border h-px flex-1" />
  </li>
);

/** Scroll only the nearest scrolling ancestor (never the page around it). */
const scrollToEnd = (node: HTMLElement | null): void => {
  for (let parent = node?.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if (overflowY === "auto" || overflowY === "scroll") {
      parent.scrollTop = parent.scrollHeight;
      return;
    }
  }
};

/**
 * Keep the newest message in view: jump to the end on first load, then
 * follow new messages only while the reader is already at the end; someone
 * scrolled up to read is never yanked down.
 */
function useFollowEnd(count: number) {
  const end = useRef<HTMLLIElement>(null);
  const atEnd = useRef(true);
  const shown = count > 0;
  useEffect(() => {
    const node = end.current;
    if (node === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      atEnd.current = entry?.isIntersecting ?? true;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [shown]);
  useEffect(() => {
    if (count > 0 && atEnd.current) scrollToEnd(end.current);
  }, [count]);
  return end;
}

export function RoomTimeline({ roomId }: { roomId: string }) {
  const {
    value: detail,
    failed,
    retry,
  } = useLiveLoad(
    `room:${roomId}`,
    () => api.room(roomId),
    ["mailbox"],
    "This conversation may be out of date",
  );
  const end = useFollowEnd(detail?.timeline.length ?? 0);

  if (failed)
    return (
      <div className="px-4 pt-3">
        <ErrorState message="Couldn't load the conversation." onRetry={retry} />
      </div>
    );
  if (detail === null) return <SkeletonRows label="Loading the conversation" rows={4} />;

  const seated = seatLines(detail.timeline);
  return (
    <ol
      aria-label="Bot talk, read-only"
      className="flex flex-col gap-3 px-4 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))]"
    >
      {seated.map((entry, index) => (
        <Fragment key={entry.line.id ?? index}>
          {entry.divider !== null && <DayDivider label={entry.divider} />}
          <RoomTurn seated={entry} />
        </Fragment>
      ))}
      <li ref={end} className="text-muted-foreground py-6 text-center text-xs">
        {seated.length === 0 ? "No messages yet." : "Only bots write here. You can read along."}
      </li>
    </ol>
  );
}
