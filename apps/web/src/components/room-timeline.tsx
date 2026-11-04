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
import { BotAvatar } from "@/components/bot-avatar";
import { ChatProse, isFoldable } from "@/components/chat-prose";
import { ErrorState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { api, type RoomLine } from "@/lib/api";
import { formatClock, formatFull } from "@/lib/format";
import { deliveryNote } from "@/lib/room-status";
import { seatLines, type SeatedLine } from "@/lib/room-turns";
import { useLiveLoad } from "@/lib/use-live-load";
import { cn } from "@/lib/utils";
import { enter } from "@/components/system/card-shell";

/** Delivery state under its line, with the recorded reason when it adds one. */
function Delivery({ line }: { line: RoomLine }) {
  const note = deliveryNote(line);
  if (note === null) return null;
  return (
    <div className="flex max-w-full flex-col text-xs">
      <p
        className={cn(
          "inline-flex items-center gap-1.5",
          note.tone === "error" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {note.tone === "error" && <CircleAlertIcon className="size-3 shrink-0" aria-hidden />}
        {note.label}
      </p>
      {note.reason !== null && <p className="text-muted-foreground break-words">{note.reason}</p>}
    </div>
  );
}

function RoomTurn({ seated }: { seated: SeatedLine }) {
  const { line, grouped } = seated;
  if (line.system)
    return (
      <li className={cn("text-muted-foreground w-full text-center text-xs", enter)}>{line.text}</li>
    );
  return (
    <li
      className={cn(
        "group/msg flex w-full min-w-0 flex-col items-start gap-0.5",
        grouped && "-mt-1.5",
        enter,
      )}
      title={formatFull(line.at)}
    >
      {!grouped && (
        <div
          data-slot="room-head"
          className="text-muted-foreground flex items-center gap-1.5 text-sm font-medium"
        >
          <BotAvatar id={line.speakerId} name={line.speaker} size="sm" />
          {line.speaker}
          <time className="readout" dateTime={new Date(line.at).toISOString()}>
            {formatClock(line.at)}
          </time>
        </div>
      )}
      <div className="min-w-0 max-w-full">
        <ChatProse text={line.text} foldable={isFoldable(line.text)} />
      </div>
      <Delivery line={line} />
    </li>
  );
}

const DayDivider = ({ label }: { label: string }) => (
  <li role="separator" className="text-muted-foreground/70 flex items-center gap-3 py-1">
    <span className="bg-border h-px flex-1" />
    <span className="readout text-xs">{label}</span>
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
