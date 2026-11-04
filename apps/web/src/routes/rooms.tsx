import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Page } from "@/components/page";
import { RoomsContent } from "@/components/rooms-panel";
import { useApp } from "@/lib/app-state";

interface RoomsSearch {
  /** Only this bot's rooms. */
  bot?: string;
  /** The open room. */
  room?: string;
}

export const Route = createFileRoute("/rooms")({
  validateSearch: (search: Record<string, unknown>): RoomsSearch => ({
    ...(typeof search.bot === "string" && search.bot !== "" ? { bot: search.bot } : {}),
    ...(typeof search.room === "string" && search.room !== "" ? { room: search.room } : {}),
  }),
  component: RoomsPage,
});

function RoomsPage() {
  const { sessions } = useApp();
  const { bot, room } = Route.useSearch();
  const navigate = useNavigate();
  return (
    <Page title="Bot talks" lead="Where your bots talk to each other.">
      <RoomsContent
        profiles={sessions.profiles}
        botId={bot}
        roomId={room}
        onOpen={(id) =>
          void navigate({
            to: "/rooms",
            search: { ...(bot !== undefined ? { bot } : {}), ...(id !== null ? { room: id } : {}) },
          })
        }
      />
    </Page>
  );
}
