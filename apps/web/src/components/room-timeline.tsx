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
import { Fragment, useEffect, useRef, useState } from "react";
import { CircleAlertIcon, SendHorizontalIcon } from "lucide-react";
import { ChatProse, isFoldable } from "@/components/chat-prose";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
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

/** The owner's composer under a bot talk: speak as yourself, to one bot. */
function RoomComposer({
  roomId,
  participants,
  onSent,
}: {
  roomId: string;
  participants: { profileId: string; name: string }[];
  onSent: () => void;
}) {
  const [text, setText] = useState("");
  const [to, setTo] = useState(participants[0]?.profileId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (): Promise<void> => {
    const body = text.trim();
    if (body === "" || to === "") return;
    setBusy(true);
    setError(null);
    try {
      await api.roomSay(roomId, body, to);
      setText("");
      onSent();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="border-border/60 bg-background/80 sticky bottom-0 border-t px-4 py-2 backdrop-blur">
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label className="sr-only" htmlFor="room-say-to">
          Which bot
        </label>
        <select
          id="room-say-to"
          className="bg-card border-border h-9 shrink-0 rounded-lg border px-2 text-xs"
          value={to}
          onChange={(event) => setTo(event.target.value)}
        >
          {participants.map((bot) => (
            <option key={bot.profileId} value={bot.profileId}>
              to {bot.name}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="room-say-text">
          Message
        </label>
        <input
          id="room-say-text"
          className="bg-card h-9 min-w-0 flex-1 rounded-lg border border-transparent px-3 text-sm outline-none focus-visible:border-[var(--accent-tone)]"
          placeholder="Speak as yourself into this talk"
          value={text}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={busy || text.trim() === ""}>
          {busy ? <Spinner /> : <SendHorizontalIcon />}
          <span className="sr-only">Send</span>
        </Button>
      </form>
      {error !== null && <p className="text-destructive mt-1 text-xs">{error}</p>}
    </div>
  );
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
      <div className="px-3 pt-3">
        <ErrorState message="Couldn't load the conversation." onRetry={retry} />
      </div>
    );
  if (detail === null) return <SkeletonRows label="Loading the conversation" rows={4} />;

  const seated = seatLines(detail.timeline);
  return (
    <>
      <ol aria-label="Bot talk" className="flex flex-col gap-3 px-3 pt-3">
        {seated.map((entry, index) => (
          <Fragment key={entry.line.id ?? index}>
            {entry.divider !== null && <DayDivider label={entry.divider} />}
            <RoomTurn seated={entry} />
          </Fragment>
        ))}
        <li ref={end} className="text-muted-foreground py-6 text-center text-xs">
          {seated.length === 0 ? "No messages yet." : "Bots write here; you can read along."}
        </li>
      </ol>
      <RoomComposer roomId={roomId} participants={detail.participants} onSent={retry} />
    </>
  );
}
