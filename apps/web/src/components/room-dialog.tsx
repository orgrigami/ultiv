/**
 * Bot talks in a dialog: the read-only room timeline a chat-side mail pill
 * opens. The full surface (supervision "say", the list) stays on /rooms —
 * this is the peek: who said what, when, and whether it arrived.
 */
import { useCallback, useEffect, useState } from "react";
import { UserIcon } from "lucide-react";
import { BotAvatar } from "@/components/bot-avatar";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { api, type RoomDetail } from "@/lib/api";
import { formatClock, formatWhen } from "@/lib/format";
import { notifyError } from "@/lib/notify";
import { STATUS_LABEL } from "@/lib/room-status";
import { enter } from "@/components/system/card-shell";

export function RoomDialog({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<RoomDetail | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setDetail(await api.room(roomId));
  }, [roomId]);

  useEffect(() => {
    load().catch((cause: unknown) => {
      notifyError("Couldn't load the conversation", cause, "room-dialog-load");
      setFailed(true);
    });
  }, [load]);

  const profileIdOf = (speaker: string): string | undefined =>
    detail?.participants.find((participant) => participant.name === speaker)?.profileId;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:w-[min(40rem,92vw)]">
        <DialogTitle>
          {detail === null
            ? "Bot talks"
            : detail.participants.map((participant) => participant.name).join(" ↔ ")}
        </DialogTitle>
        {detail !== null && detail.room.topic !== "" && (
          <p className="text-muted-foreground -mt-2 text-xs">
            {detail.room.topic} · started {formatWhen(detail.room.createdAt)}
          </p>
        )}
        <div className="mt-1 max-h-[60dvh] overflow-y-auto">
          {failed ? (
            <ErrorState message="Couldn't load the conversation." onRetry={() => void load()} />
          ) : detail === null ? (
            <SkeletonRows label="Loading the conversation" rows={4} />
          ) : detail.timeline.length === 0 ? (
            <p className="text-muted-foreground py-6 text-center text-xs">No messages yet.</p>
          ) : (
            <ol className="flex flex-col gap-4">
              {detail.timeline.map((line, index) => {
                const status = line.status === undefined ? undefined : STATUS_LABEL[line.status];
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: append-only timeline
                  <li key={line.id ?? index} className={`flex gap-2.5 ${enter}`}>
                    {line.system || line.speaker === "owner" ? (
                      <span className="bg-muted text-muted-foreground mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full">
                        <UserIcon className="size-3.5" />
                      </span>
                    ) : (
                      <BotAvatar id={profileIdOf(line.speaker)} name={line.speaker} size="sm" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="flex items-baseline gap-2">
                        <span
                          className={`text-xs font-semibold ${
                            line.speaker === "owner" ? "text-accent-foreground" : ""
                          }`}
                        >
                          {line.speaker}
                        </span>
                        <span className="text-muted-foreground readout text-xs">
                          {formatClock(line.at)}
                        </span>
                      </p>
                      <div className="text-chat break-words [&_p:first-child]:mt-1 [&_p:last-child]:mb-0">
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
                );
              })}
            </ol>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
