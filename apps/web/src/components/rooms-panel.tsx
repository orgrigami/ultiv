/**
 * Bot talks (rooms): bot-to-bot conversations, READ-ONLY to the owner. The
 * list and the open conversation both refetch on the live "mailbox" signal;
 * the conversation itself is the same `RoomTimeline` the work pane shows.
 */
import { CharacterEmpty } from "@/components/character-empty";
import { RoomTimeline } from "@/components/room-timeline";
import { SkeletonRows } from "@/components/ui/skeleton";
import { ArrowLeftIcon, MessagesSquareIcon } from "lucide-react";
import type { ProfileInfo, RoomInfo } from "@spriessen/contracts";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/empty-state";
import { ListRow } from "@/components/ui/list-row";
import { Tile } from "@/components/ui/tile";
import { api } from "@/lib/api";
import { formatWhen } from "@/lib/format";
import { useLiveLoad } from "@/lib/use-live-load";

function OpenRoom({
  roomId,
  room,
  nameOf,
  onBack,
}: {
  roomId: string;
  /** The list's row, when the room is in it (it may be filtered out). */
  room: RoomInfo | undefined;
  nameOf: (profileId: string) => string;
  onBack: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
        <ArrowLeftIcon /> All conversations
      </Button>
      {room !== undefined && (
        <p className="text-muted-foreground px-1 text-xs">
          {room.participants.map(nameOf).join(" ↔ ")}
          {room.topic !== "" ? ` • ${room.topic}` : ""}
        </p>
      )}
      <Tile tone="surface" radius="lg" className="max-h-[70dvh] overflow-y-auto">
        <RoomTimeline roomId={roomId} />
      </Tile>
    </div>
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

  const nameOf = (profileId: string): string =>
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
      <CharacterEmpty title="No bot talks yet">
        Bots start one when they message each other, one per topic.
      </CharacterEmpty>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {rooms.map((room) => (
        <ListRow
          key={room.id}
          leading={<MessagesSquareIcon />}
          title={room.participants.map(nameOf).join(" ↔ ")}
          subtitle={room.topic !== "" ? room.topic : undefined}
          meta={formatWhen(room.lastMessageAt)}
          onClick={() => onOpen(room.id)}
        />
      ))}
    </div>
  );
}
