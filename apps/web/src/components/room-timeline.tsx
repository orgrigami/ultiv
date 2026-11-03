/**
 * A bot-to-bot conversation as a real chat: one bubble per turn, speakers
 * seated on opposite sides (the room's first participant left, everyone else
 * right, the owner's supervision lines right), consecutive turns grouped
 * under one avatar and name, day dividers between. Opened from a mail pill,
 * it lives in the work pane — beside the chat on desktop, full-height sheet
 * on phones.
 */
import { Fragment, useCallback, useEffect, useState } from "react";
import { CircleAlertIcon, UserIcon } from "lucide-react";
import { BotAvatar } from "@/components/bot-avatar";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { ErrorState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { api, type RoomDetail, type RoomLine } from "@/lib/api";
import { formatClock, formatDivider, formatFull } from "@/lib/format";
import { notifyError } from "@/lib/notify";
import { STATUS_LABEL } from "@/lib/room-status";
import { cn } from "@/lib/utils";
import { enter } from "@/components/system/card-shell";

const bubbleOf = (side: "left" | "right", grouped: boolean, owner: boolean): string =>
  cn(
    "w-fit max-w-full rounded-2xl border px-3.5 py-2.5 text-chat break-words",
    "[&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_p]:my-1.5 [&_li]:my-0.5 [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
    side === "left"
      ? "bg-muted/70 border-border/60"
      : owner
        ? "bg-accent/15 border-accent/30"
        : "bg-card border-border",
    grouped ? (side === "left" ? "rounded-tl-sm" : "rounded-tr-sm") : "",
  );

const Meta = ({ line, side }: { line: RoomLine; side: "left" | "right" }) => (
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

export function RoomTimeline({ roomId }: { roomId: string }) {
  const [detail, setDetail] = useState<RoomDetail | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setDetail(await api.room(roomId));
  }, [roomId]);

  useEffect(() => {
    load().catch((cause: unknown) => {
      notifyError("Couldn't load the conversation", cause, "room-timeline-load");
      setFailed(true);
    });
  }, [load]);

  if (failed)
    return (
      <div className="px-4 pt-3">
        <ErrorState message="Couldn't load the conversation." onRetry={() => void load()} />
      </div>
    );
  if (detail === null) return <SkeletonRows label="Loading the conversation" rows={4} />;

  const profileIdOf = (speaker: string): string | undefined =>
    detail.participants.find((participant) => participant.name === speaker)?.profileId;
  /** The room's first participant sits left; everyone else (and the owner's
   *  supervision lines) answer from the right, like a two-sided chat. */
  const sideOf = (speaker: string, system: boolean): "left" | "right" => {
    if (system || speaker === "owner") return "right";
    const index = detail.participants.findIndex((participant) => participant.name === speaker);
    return index <= 0 ? "left" : "right";
  };

  let lastDay = "";
  let lastSpeaker: string | null = null;
  let lastWasTurn = false;

  return (
    <ol className="flex flex-col gap-2.5 px-4 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
      {detail.timeline.map((line, index) => {
        const divider = formatDivider(line.at);
        const showDivider = divider !== lastDay;
        if (showDivider) lastDay = divider;
        const status = line.status === undefined ? undefined : STATUS_LABEL[line.status];
        const side = sideOf(line.speaker, line.system);
        const owner = line.system || line.speaker === "owner";
        // A new turn: different speaker, a day break, or a non-message line.
        const newTurn = showDivider || line.system || line.speaker !== lastSpeaker || !lastWasTurn;
        const grouped = !newTurn;
        lastSpeaker = line.speaker;
        lastWasTurn = !line.system;

        return (
          <Fragment key={line.id ?? index}>
            {showDivider && (
              <li
                role="separator"
                className="text-muted-foreground/70 flex items-center gap-3 py-1"
              >
                <span className="bg-border h-px flex-1" />
                <span className="readout text-xs">{divider}</span>
                <span className="bg-border h-px flex-1" />
              </li>
            )}
            {line.system ? (
              <li className={`w-full ${enter}`}>
                <p className="text-muted-foreground text-center text-xs italic">{line.text}</p>
              </li>
            ) : (
              <li
                className={cn(
                  "flex w-full items-end gap-2",
                  side === "right" && "flex-row-reverse",
                  enter,
                )}
              >
                {grouped ? (
                  <span className="w-7 shrink-0" aria-hidden />
                ) : owner ? (
                  <span className="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-full">
                    <UserIcon className="size-3.5" />
                  </span>
                ) : (
                  <BotAvatar id={profileIdOf(line.speaker)} name={line.speaker} size="sm" />
                )}
                <div
                  className={cn(
                    "flex min-w-0 max-w-[88%] flex-col gap-0.5 sm:max-w-[78%]",
                    side === "right" && "items-end",
                  )}
                >
                  {!grouped && <Meta line={line} side={side} />}
                  <div className={bubbleOf(side, grouped, owner)} data-slot="room-bubble">
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
            )}
          </Fragment>
        );
      })}
      {detail.timeline.length === 0 && (
        <li className="text-muted-foreground py-8 text-center text-xs">No messages yet.</li>
      )}
    </ol>
  );
}
