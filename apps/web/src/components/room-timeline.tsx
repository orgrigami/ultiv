/**
 * A bot-to-bot room as the house transcript: bot prose is the terrain (no
 * bubble, no side alignment), each turn headed by its speaker's drawn
 * character and name; the owner's supervision lines sit on the same quiet
 * raised card the main chat uses; day dividers between. Lives under the
 * room header on /rooms and in the work pane (opened from a mail pill).
 */
import { Fragment, useCallback, useEffect, useState } from "react";
import { CircleAlertIcon } from "lucide-react";
import { BotAvatar } from "@/components/bot-avatar";
import { ChatProse, isFoldable } from "@/components/chat-prose";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { api, type RoomDetail, type RoomLine } from "@/lib/api";
import { formatClock, formatDivider, formatFull } from "@/lib/format";
import { notifyError } from "@/lib/notify";
import { STATUS_LABEL } from "@/lib/room-status";
import { cn } from "@/lib/utils";
import { enter } from "@/components/system/card-shell";

/** Delivery status under its line; a still-pending one carries a Cancel. */
function StatusLine({ line, onCancel }: { line: RoomLine; onCancel: (id: string) => void }) {
  const label = line.status === undefined ? undefined : STATUS_LABEL[line.status];
  if (label === undefined) return null;
  const cancelId = line.status === "pending" && line.id !== undefined ? line.id : undefined;
  return (
    <p
      className={cn(
        "inline-flex items-center gap-1.5 text-xs",
        line.status === "pending" ? "text-muted-foreground" : "text-destructive",
      )}
    >
      {line.status !== "pending" && <CircleAlertIcon className="size-3 shrink-0" aria-hidden />}
      {label}
      {cancelId !== undefined && (
        <Button variant="quiet" size="xs" onClick={() => onCancel(cancelId)}>
          Cancel
        </Button>
      )}
    </p>
  );
}

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

  const cancel = useCallback(
    async (id: string) => {
      try {
        await api.mailboxCancel(id);
        await load();
      } catch (cause) {
        notifyError("Couldn't cancel the message", cause);
      }
    },
    [load],
  );

  if (failed)
    return (
      <div className="px-4 pt-3">
        <ErrorState message="Couldn't load the conversation." onRetry={() => void load()} />
      </div>
    );
  if (detail === null) return <SkeletonRows label="Loading the conversation" rows={4} />;

  const profileIdOf = (speaker: string): string | undefined =>
    detail.participants.find((participant) => participant.name === speaker)?.profileId;

  let lastDay = "";

  return (
    <ol className="flex flex-col gap-3 px-4 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
      {detail.timeline.map((line, index) => {
        const divider = formatDivider(line.at);
        const showDivider = divider !== lastDay;
        if (showDivider) lastDay = divider;
        const owner = line.speaker === "owner" && !line.system;

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
              <li className={cn("text-muted-foreground w-full text-center text-xs", enter)}>
                {line.text}
              </li>
            ) : owner ? (
              <li className={cn("flex w-full flex-col items-end gap-1", enter)}>
                <div
                  data-slot="room-owner-line"
                  className="max-w-[80%] rounded-xl bg-muted/70 px-3.5 py-2.5 text-chat break-words whitespace-pre-wrap"
                  title={formatFull(line.at)}
                >
                  {line.text}
                </div>
                <StatusLine line={line} onCancel={(id) => void cancel(id)} />
              </li>
            ) : (
              <li
                className={cn("group/msg flex w-full min-w-0 flex-col items-start gap-0.5", enter)}
                title={formatFull(line.at)}
              >
                <div
                  data-slot="room-head"
                  className="text-muted-foreground flex items-center gap-1.5 text-sm font-medium"
                >
                  <BotAvatar id={profileIdOf(line.speaker)} name={line.speaker} size="sm" />
                  {line.speaker}
                  <time className="readout" dateTime={new Date(line.at).toISOString()}>
                    {formatClock(line.at)}
                  </time>
                </div>
                <div className="min-w-0 max-w-full">
                  <ChatProse text={line.text} foldable={isFoldable(line.text)} />
                </div>
                <StatusLine line={line} onCancel={(id) => void cancel(id)} />
              </li>
            )}
          </Fragment>
        );
      })}
      {detail.timeline.length === 0 && (
        <li className="text-muted-foreground py-8 text-center text-sm">No messages yet.</li>
      )}
    </ol>
  );
}
