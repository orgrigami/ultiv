/**
 * Home = ONE chat with the active bot (?bot=<id>; none = the main bot). The
 * bot switcher is the chat's header pill; the other sections are routes
 * reached from the tab bar (phones) or the side rail (desktop).
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { BotsPanel } from "@/components/bots-panel";
import { Chat } from "@/components/chat";
import { OnboardingHome } from "@/components/onboarding";
import { api } from "@/lib/api";
import { useApp } from "@/lib/app-state";

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): { bot?: string } =>
    typeof search.bot === "string" && search.bot !== "" ? { bot: search.bot } : {},
  component: HomePage,
});

/** The chat column shared by / and /c/$sessionId. */
export const chatColumn = "mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col px-4 sm:px-6";

function HomePage() {
  const { sessions, mainId, epoch, refreshAll, setLastBot } = useApp();
  const navigate = useNavigate();
  const activeId = Route.useSearch().bot;
  const profileId = activeId ?? mainId;
  // The chat is stamped with the bot it belongs to: while a switch is still
  // fetching the new bot's chat, the old one must not show under the new
  // bot's name (a message sent then would reach the wrong bot).
  const [chat, setChat] = useState<{ profileId: string; id: string } | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const chatId = chat !== null && chat.profileId === profileId ? chat.id : null;

  useEffect(() => setLastBot(activeId), [activeId, setLastBot]);

  useEffect(() => {
    if (profileId === null) {
      setChat(null);
      return;
    }
    let stale = false;
    setChatError(null);
    api
      .mainChat(profileId)
      .then((session) => {
        if (!stale) {
          setChat({ profileId, id: session.id });
          setChatError(null);
        }
      })
      .catch((cause) => {
        if (!stale) setChatError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      stale = true;
    };
  }, [profileId, epoch]);

  const open = (id: string): void => {
    void navigate({ to: "/", search: id === mainId ? {} : { bot: id } });
  };

  if (sessions.profiles.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto pb-[calc(var(--tabbar-h)+1rem+env(safe-area-inset-bottom))]">
        <div className={chatColumn}>
          <OnboardingHome
            models={sessions.models}
            custom={
              <BotsPanel
                profiles={sessions.profiles}
                models={sessions.models}
                activeId={null}
                mainId={mainId}
                refresh={refreshAll}
                onOpenMain={open}
              />
            }
            onCreated={async (id) => {
              await refreshAll();
              open(id);
            }}
          />
        </div>
      </div>
    );
  }

  const bot = sessions.profiles.find((profile) => profile.id === profileId);
  return (
    <div className={chatColumn}>
      {chatId !== null ? (
        // Keyed: a draft or staged file never carries over to another chat.
        <Chat key={chatId} sessionId={chatId} models={sessions.models} bot={bot} />
      ) : (
        <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
          {chatError !== null ? `Couldn't open the chat: ${chatError}` : "Opening the chat…"}
        </div>
      )}
    </div>
  );
}
