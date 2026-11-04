/**
 * Bot talks (rooms) in the house voice, READ-ONLY to the owner: list rows
 * carry the pair's characters and a mono last-activity readout; an open room
 * shows the pair header and the terrain transcript (the same `RoomTimeline`
 * the work pane shows), with no composer. The list and the open room both
 * refetch on the live "mailbox" signal.
 */
import { ArrowLeftIcon } from "lucide-react";
import type { ProfileInfo, RoomInfo } from "@spriessen/contracts";
import { BotAvatar } from "@/components/bot-avatar";
import { RoomTimeline } from "@/components/room-timeline";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { Heading } from "@/components/ui/heading";
import { ListRow } from "@/components/ui/list-row";
import { SkeletonRows } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { formatWhen } from "@/lib/format";
import { useLiveLoad } from "@/lib/use-live-load";
import { cn } from "@/lib/utils";

type NameOf = (profileId: string) => string;

/** The pair header: both characters, the names, the topic as the lead. */
function PairHeader({ room, nameOf }: { room: RoomInfo; nameOf: NameOf }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {room.participants.map((id) => (
          <BotAvatar key={id} id={id} name={nameOf(id)} size="md" />
        ))}
        <Heading level={2} size="base">
          {room.participants.map(nameOf).join(" ↔ ")}
        </Heading>
      </div>
      {room.topic !== "" && <p className="text-muted-foreground text-sm">{room.topic}</p>}
    </div>
  );
}

function OpenRoom({
  roomId,
  room,
  nameOf,
  onBack,
}: {
  roomId: string;
  /** The list's row, when the room is in it (a linked room may be filtered out). */
  room: RoomInfo | undefined;
  nameOf: NameOf;
  onBack: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
        <ArrowLeftIcon /> All conversations
      </Button>
      {room !== undefined && <PairHeader room={room} nameOf={nameOf} />}
      <RoomTimeline roomId={roomId} />
    </div>
  );
}

function RoomRow({ room, nameOf, onOpen }: { room: RoomInfo; nameOf: NameOf; onOpen: () => void }) {
  return (
    <ListRow
      leading={
        <span className={cn("flex items-center", room.participants.length > 1 && "-space-x-1.5")}>
          {room.participants.map((id) => (
            <BotAvatar key={id} id={id} name={nameOf(id)} size="sm" />
          ))}
        </span>
      }
      title={room.participants.map(nameOf).join(" ↔ ")}
      subtitle={room.topic !== "" ? room.topic : undefined}
      meta={
        <time className="readout" dateTime={new Date(room.lastMessageAt).toISOString()}>
          {formatWhen(room.lastMessageAt)}
        </time>
      }
      onClick={onOpen}
    />
  );
}

export function RoomsContent({
  profiles,
  botId,
  roomId,
  onOpen,
}: {
  profiles: ProfileInfo[];
  /** Only this bot's rooms. */
  botId?: string | undefined;
  /** The open room (from the URL), undefined = the list. */
  roomId?: string | undefined;
  onOpen: (roomId: string | null) => void;
}) {
  const {
    value: rooms,
    failed,
    retry,
  } = useLiveLoad(
    `rooms:${botId ?? "*"}`,
    () => api.rooms(botId),
    ["mailbox", "profiles"],
    "Bot talks may be out of date",
  );

  const nameOf: NameOf = (profileId) =>
    profiles.find((profile) => profile.id === profileId)?.name ??
    profileId.replace(/^external:/, "").slice(0, 8);

  if (roomId !== undefined) {
    return (
      <OpenRoom
        roomId={roomId}
        room={rooms?.find((room) => room.id === roomId)}
        nameOf={nameOf}
        onBack={() => onOpen(null)}
      />
    );
  }
  if (failed) return <ErrorState message="Couldn't load the conversations." onRetry={retry} />;
  if (rooms === null) return <SkeletonRows label="Loading bot talks" />;
  if (rooms.length === 0) {
    return (
      <EmptyState className="py-8 text-center">
        No bot talks yet. One starts when two bots message each other.
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {rooms.map((room) => (
        <RoomRow key={room.id} room={room} nameOf={nameOf} onOpen={() => onOpen(room.id)} />
      ))}
    </div>
  );
}
