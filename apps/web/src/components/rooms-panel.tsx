/**
 * Bot talks (rooms) in the house voice: an open room shows the pair header,
 * the terrain transcript and the house composer with a quiet
 * supervision-target control; the footer strip is gone (the header says it).
 */
import { Menu } from "@base-ui/react/menu";
import {
  ChevronDownIcon,
  CheckIcon,
  MessagesSquareIcon,
  SendIcon,
  ArrowLeftIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ProfileInfo, RoomInfo } from "@spriessen/contracts";
import { CharacterEmpty } from "@/components/character-empty";
import { BotAvatar } from "@/components/bot-avatar";
import { RoomTimeline } from "@/components/room-timeline";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/empty-state";
import { ListRow } from "@/components/ui/list-row";
import { MenuPopup } from "@/components/ui/menu-popup";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api, type RoomDetail } from "@/lib/api";
import { formatWhen } from "@/lib/format";
import { grownBoxStyle, useGrownBox } from "@/lib/grown-box";
import { notifyError } from "@/lib/notify";

const itemClass =
  "data-highlighted:bg-muted flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm outline-none";

/** Who a supervision line is spoken to: a quiet menu inside the composer. */
function TargetControl({
  participants,
  value,
  onChange,
}: {
  participants: { profileId: string; name: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  const current = participants.find((participant) => participant.profileId === value);
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={
          current === undefined
            ? "Choose who receives this"
            : `Speaking to ${current.name}. Change who receives this`
        }
        className="text-muted-foreground hover:bg-muted focus-visible:ring-ring/50 inline-flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-full py-1 pr-2 pl-1 text-xs font-medium outline-none focus-visible:ring-3 pointer-coarse:h-10"
      >
        {current !== undefined && (
          <BotAvatar id={current.profileId} name={current.name} size="sm" />
        )}
        {current?.name}
        <ChevronDownIcon className="size-3.5" aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start" sideOffset={8} className="z-50">
          <MenuPopup className="w-56">
            <p className="text-muted-foreground px-3 pt-2 pb-1 text-xs">Speaking to</p>
            <Menu.RadioGroup value={value} onValueChange={(next: string) => onChange(next)}>
              {participants.map((participant) => (
                <Menu.RadioItem
                  key={participant.profileId}
                  value={participant.profileId}
                  closeOnClick
                  className={itemClass}
                >
                  <span className="flex size-4 shrink-0 items-center">
                    <Menu.RadioItemIndicator>
                      <CheckIcon className="size-4" />
                    </Menu.RadioItemIndicator>
                  </span>
                  <BotAvatar id={participant.profileId} name={participant.name} size="sm" />
                  {participant.name}
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </MenuPopup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

const coarsePointer = (): boolean =>
  typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

function RoomView({ room, reload }: { room: RoomInfo; reload: () => Promise<void> }) {
  const [detail, setDetail] = useState<RoomDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const { boxRef, grown } = useGrownBox(draft);

  const load = useCallback(async () => {
    setDetail(await api.room(room.id));
  }, [room.id]);

  useEffect(() => {
    load().catch((cause: unknown) => notifyError("Couldn't load the room", cause, "room-load"));
  }, [load]);

  useEffect(() => {
    if (detail !== null && to === "" && detail.participants.length > 0) {
      setTo(detail.participants[0]?.profileId ?? "");
    }
  }, [detail, to]);

  const send = async (): Promise<void> => {
    if (draft.trim() === "" || to === "") return;
    setBusy(true);
    try {
      await api.roomSay(room.id, to, draft.trim());
      setDraft("");
      await load();
      await reload();
    } catch (cause) {
      notifyError("Message not sent", cause);
    } finally {
      setBusy(false);
    }
  };

  if (detail === null) return <SkeletonRows label="Loading the conversation" rows={4} />;
  const target = detail.participants.find((participant) => participant.profileId === to);

  return (
    <div className="flex flex-col gap-3">
      {/* The pair header: both characters, the names, the topic as the lead. */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          {detail.participants.map((participant) => (
            <BotAvatar
              key={participant.profileId}
              id={participant.profileId}
              name={participant.name}
              size="md"
            />
          ))}
          <h2 className="text-base font-semibold tracking-tight">
            {detail.participants.map((participant) => participant.name).join(" ↔ ")}
          </h2>
        </div>
        {room.topic !== "" && <p className="text-muted-foreground text-sm">{room.topic}</p>}
      </div>
      <RoomTimeline roomId={room.id} />
      <form
        className="sticky bottom-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div
          ref={boxRef}
          className="chrome-float focus-within:ring-ring/40 flex items-end gap-1.5 p-1.5 focus-within:ring-2 transition-[border-radius] duration-200 ease-out motion-reduce:transition-none"
          style={grownBoxStyle(grown)}
        >
          <TargetControl participants={detail.participants} value={to} onChange={setTo} />
          <Textarea
            variant="bare"
            aria-label={`Message to ${target?.name ?? "the room"}`}
            placeholder={target !== undefined ? `Message ${target.name}` : "Message the room"}
            value={draft}
            rows={1}
            className="max-h-[40dvh] min-w-0 flex-1 resize-none overflow-y-auto"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || coarsePointer() || event.shiftKey) return;
              event.preventDefault();
              void send();
            }}
          />
          <Button
            type="submit"
            size="composer"
            pill
            aria-label="Send message"
            disabled={busy || draft.trim() === ""}
          >
            <SendIcon />
          </Button>
        </div>
      </form>
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
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setRooms(await api.rooms(botId));
      setLoadFailed(false);
    } catch {
      // A failed load is not an empty list: say so and offer a retry.
      setLoadFailed(true);
    } finally {
      setLoaded(true);
    }
  }, [botId]);

  useEffect(() => {
    void load();
  }, [load]);

  const nameOf = (profileId: string): string =>
    profiles.find((profile) => profile.id === profileId)?.name ?? profileId.slice(0, 8);
  const open = rooms.find((room) => room.id === roomId);

  if (loadFailed && rooms.length === 0) {
    return <ErrorState message="Couldn't load the conversations." onRetry={() => void load()} />;
  }
  if (open !== undefined) {
    return (
      <div className="flex flex-col gap-2">
        <Button variant="ghost" size="sm" className="self-start" onClick={() => onOpen(null)}>
          <ArrowLeftIcon /> All conversations
        </Button>
        <RoomView room={open} reload={load} />
      </div>
    );
  }
  if (!loaded) return <SkeletonRows label="Loading bot talks" />;
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
          title={room.participants.map((id) => nameOf(id)).join(" ↔ ")}
          subtitle={room.topic !== "" ? room.topic : undefined}
          meta={formatWhen(room.lastMessageAt)}
          onClick={() => onOpen(room.id)}
        />
      ))}
    </div>
  );
}
