/**
 * A bot-to-bot conversation as a real chat, READ-ONLY: bots write here, the
 * owner reads along (no composer, no cancel). One bubble per turn, the
 * room's first participant left and the other bot right, consecutive turns
 * grouped under one avatar and name, day dividers between; seating and
 * grouping rules live in `lib/room-turns.ts`. It refetches on the live
 * "mailbox" signal and follows new messages while scrolled to the end.
 * Used by the work pane (opened from a mail pill) and the Bot talks page.
 */
import { Fragment, useEffect, useRef } from "react";
import { CircleAlertIcon } from "lucide-react";
import { BotAvatar } from "@/components/bot-avatar";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { ErrorState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { api, type RoomLine } from "@/lib/api";
import { formatClock, formatFull } from "@/lib/format";
import { seatLines, type SeatedLine, type Side } from "@/lib/room-turns";
import { deliveryNote } from "@/lib/room-status";
import { useLiveLoad } from "@/lib/use-live-load";
import { cn } from "@/lib/utils";
import { enter } from "@/components/system/card-shell";

const bubbleOf = ({ side, grouped }: SeatedLine): string =>
  cn(
    "w-fit max-w-full rounded-2xl border px-3.5 py-2.5 text-chat leading-relaxed break-words",
    "[&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_p]:my-1 [&_li]:my-0.5 [&_ul]:my-1.5 [&_ol]:my-1.5",
    "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
    // Inline code only: a fenced block's <code> sits in a <pre> and keeps
    // the CodeBlock's own look.
    "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted/60 [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:text-[0.85em]",
    side === "left" ? "bg-muted/70 border-border/60" : "bg-card border-border",
    grouped ? (side === "left" ? "rounded-tl-sm" : "rounded-tr-sm") : "",
  );

const Meta = ({ line, side }: { line: RoomLine; side: Side }) => (
  <p className={cn("text-xs", side === "right" && "text-right")}>
    <span className="font-semibold">{line.speaker}</span>
    <time
      className="text-muted-foreground readout ml-2"
      dateTime={new Date(line.at).toISOString()}
      title={formatFull(line.at)}
    >
      {formatClock(line.at)}
    </time>
  </p>
);

function Avatar({ seated }: { seated: SeatedLine }) {
  if (seated.grouped) return <span className="w-7 shrink-0" aria-hidden />;
  return <BotAvatar id={seated.line.speakerId} name={seated.line.speaker} size="sm" />;
}

function Delivery({ line, side }: { line: RoomLine; side: Side }) {
  const note = deliveryNote(line);
  if (note === null) return null;
  return (
    <div
      className={cn("flex max-w-full flex-col text-xs", side === "right" && "items-end text-right")}
    >
      <p
        className={cn(
          "flex items-center gap-1.5",
          note.tone === "error" ? "text-destructive" : "text-muted-foreground",
          side === "right" && "flex-row-reverse",
        )}
      >
        {note.tone === "error" && <CircleAlertIcon className="size-3 shrink-0" />}
        {note.label}
      </p>
      {note.reason !== null && <p className="text-muted-foreground break-words">{note.reason}</p>}
    </div>
  );
}

function RoomTurn({ seated }: { seated: SeatedLine }) {
  const { line, side, grouped } = seated;
  if (line.system)
    return (
      <li className={`w-full ${enter}`}>
        <p className="text-muted-foreground text-center text-xs">{line.text}</p>
      </li>
    );
  return (
    <li
      className={cn("flex w-full items-end gap-2", side === "right" && "flex-row-reverse", enter)}
    >
      <Avatar seated={seated} />
      <div
        className={cn(
          "flex min-w-0 max-w-[88%] flex-col gap-0.5 sm:max-w-[78%]",
          side === "right" && "items-end",
        )}
      >
        {!grouped && <Meta line={line} side={side} />}
        <div
          className={bubbleOf(seated)}
          data-slot="room-bubble"
          title={grouped ? formatFull(line.at) : undefined}
        >
          <LazyMarkdown text={line.text} />
        </div>
        <Delivery line={line} side={side} />
      </div>
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
 * follow new messages only while the reader is already at the end — someone
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

  const seated = seatLines(detail.timeline, detail.room.participants, detail.participants);
  return (
    <ol
      aria-label="Bot talk, read-only"
      className="flex flex-col gap-2.5 px-4 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))]"
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
