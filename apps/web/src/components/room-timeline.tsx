/**
 * A bot-to-bot conversation as a real chat: one bubble per turn, speakers
 * seated on opposite sides (the room's first participant left, everyone else
 * right, the owner's supervision lines right), consecutive turns grouped
 * under one avatar and name, day dividers between. Seating and grouping
 * rules live in `lib/room-turns.ts`. Opened from a mail pill, it lives in the
 * work pane — beside the chat on desktop, full-height sheet on phones.
 */
import { Fragment, useCallback, useEffect, useState } from "react";
import { CircleAlertIcon, UserIcon } from "lucide-react";
import { BotAvatar } from "@/components/bot-avatar";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { ErrorState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { api, type RoomDetail, type RoomLine } from "@/lib/api";
import { formatClock, formatFull } from "@/lib/format";
import { notifyError } from "@/lib/notify";
import { seatLines, type SeatedLine, type Side } from "@/lib/room-turns";
import { STATUS_LABEL } from "@/lib/room-status";
import { cn } from "@/lib/utils";
import { enter } from "@/components/system/card-shell";

const bubbleOf = ({ side, grouped, owner }: SeatedLine): string =>
  cn(
    "w-fit max-w-full rounded-2xl border px-3.5 py-2.5 text-chat leading-relaxed break-words",
    "[&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_p]:my-1 [&_li]:my-0.5 [&_ul]:my-1.5 [&_ol]:my-1.5",
    "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
    // Inline code only: a fenced block's <code> sits in a <pre> and keeps
    // the CodeBlock's own look.
    "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted/60 [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:text-[0.85em]",
    side === "left"
      ? "bg-muted/70 border-border/60"
      : owner
        ? "bg-accent/15 border-accent/30"
        : "bg-card border-border",
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
  if (seated.owner)
    return (
      <span className="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-full">
        <UserIcon className="size-3.5" />
      </span>
    );
  return <BotAvatar id={seated.line.speakerId} name={seated.line.speaker} size="sm" />;
}

function RoomTurn({ seated }: { seated: SeatedLine }) {
  const { line, side, grouped } = seated;
  if (line.system)
    return (
      <li className={`w-full ${enter}`}>
        <p className="text-muted-foreground text-center text-xs">{line.text}</p>
      </li>
    );
  const status = line.status === undefined ? undefined : STATUS_LABEL[line.status];
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
        {status !== undefined && (
          <p
            className={cn(
              "flex items-center gap-1.5 text-xs",
              line.status === "pending" ? "text-muted-foreground" : "text-destructive",
              side === "right" && "flex-row-reverse",
            )}
          >
            {line.status !== "pending" && <CircleAlertIcon className="size-3 shrink-0" />}
            {status}
          </p>
        )}
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

export function RoomTimeline({ roomId }: { roomId: string }) {
  const [detail, setDetail] = useState<RoomDetail | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    setDetail(await api.room(roomId));
  }, [roomId]);

  const reload = useCallback(() => {
    load().catch((cause: unknown) => {
      notifyError("Couldn't load the conversation", cause, "room-timeline-load");
      setFailed(true);
    });
  }, [load]);

  useEffect(reload, [reload]);

  if (failed)
    return (
      <div className="px-4 pt-3">
        <ErrorState message="Couldn't load the conversation." onRetry={reload} />
      </div>
    );
  if (detail === null) return <SkeletonRows label="Loading the conversation" rows={4} />;

  const seated = seatLines(detail.timeline, detail.room.participants, detail.participants);
  return (
    <ol className="flex flex-col gap-2.5 px-4 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
      {seated.map((entry, index) => (
        <Fragment key={entry.line.id ?? index}>
          {entry.divider !== null && <DayDivider label={entry.divider} />}
          <RoomTurn seated={entry} />
        </Fragment>
      ))}
      {seated.length === 0 && (
        <li className="text-muted-foreground py-8 text-center text-xs">No messages yet.</li>
      )}
    </ol>
  );
}
