/**
 * A bot-to-bot conversation as a read-only chat: avatars, names, absolute
 * times, day dividers, delivery status. Opened from a mail pill, it lives in
 * the work pane — beside the chat on desktop, full-height sheet on phones.
 */
import { Fragment, useCallback, useEffect, useState } from "react";
import { UserIcon } from "lucide-react";
import { BotAvatar } from "@/components/bot-avatar";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { ErrorState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { api, type RoomDetail } from "@/lib/api";
import { formatClock, formatDivider, formatFull } from "@/lib/format";
import { notifyError } from "@/lib/notify";
import { STATUS_LABEL } from "@/lib/room-status";
import { enter } from "@/components/system/card-shell";

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
  let lastDay = "";

  return (
    <ol className="flex flex-col gap-4 px-4 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
      {detail.timeline.map((line, index) => {
        const divider = formatDivider(line.at);
        const showDivider = divider !== lastDay;
        if (showDivider) lastDay = divider;
        const status = line.status === undefined ? undefined : STATUS_LABEL[line.status];
        const owner = line.system || line.speaker === "owner";
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
            <li className={`flex gap-3 ${enter}`}>
              {owner ? (
                <span className="bg-muted text-muted-foreground mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full">
                  <UserIcon className="size-3.5" />
                </span>
              ) : (
                <BotAvatar id={profileIdOf(line.speaker)} name={line.speaker} size="sm" />
              )}
              <div className="min-w-0 flex-1">
                <p className="flex items-baseline gap-2">
                  <span
                    className={`text-sm font-semibold ${owner ? "text-accent-foreground" : ""}`}
                  >
                    {line.speaker}
                  </span>
                  <time
                    className="text-muted-foreground readout text-xs"
                    dateTime={new Date(line.at).toISOString()}
                    title={formatFull(line.at)}
                  >
                    {formatClock(line.at)}
                  </time>
                </p>
                <div className="text-ui mt-0.5 break-words leading-relaxed [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
                  <LazyMarkdown text={line.text} />
                </div>
                {status !== undefined && (
                  <p
                    className={`mt-1 text-xs ${
                      line.status === "pending" ? "text-muted-foreground" : "text-destructive"
                    }`}
                  >
                    {status}
                  </p>
                )}
              </div>
            </li>
          </Fragment>
        );
      })}
      {detail.timeline.length === 0 && (
        <li className="text-muted-foreground py-8 text-center text-xs">No messages yet.</li>
      )}
    </ol>
  );
}
