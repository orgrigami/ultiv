import { SearchIcon, SquarePenIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { useNewChat, useOpenChat } from "@/components/app-nav";
import { BotAvatar } from "@/components/bot-avatar";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApp } from "@/lib/app-state";
import { pastChats } from "@/lib/chats";
import { formatWhen } from "@/lib/format";

/**
 * Past chats: every bot's main chat and the chats you started, newest
 * first, with a filter that matches titles and bot names. A row opens the
 * chat; extra chats can be deleted (main chats can't, they are the bot's
 * home).
 */
export function HistoryList() {
  const { sessions } = useApp();
  const open = useOpenChat();
  const newChat = useNewChat();
  const [query, setQuery] = useState("");
  const all = pastChats({ sessions: sessions.sessions, profiles: sessions.profiles });
  const rows =
    query === ""
      ? all
      : pastChats({ sessions: sessions.sessions, profiles: sessions.profiles, query });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Filter chats</span>
          <SearchIcon
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a chat or a bot"
            className="h-10 rounded-full pl-9"
          />
        </label>
        <Button
          variant="outline"
          className="h-10 rounded-full"
          disabled={!newChat.ready}
          title={newChat.ready ? undefined : "Waiting for the server"}
          onClick={() => void newChat.start()}
        >
          <SquarePenIcon data-icon="inline-start" /> New chat
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-muted-foreground px-1 py-6 text-center text-sm">
          {all.length === 0 ? "No chats yet. Say hello on the Chat tab." : "No chat matches that."}
        </p>
      ) : (
        <ul aria-label="Past chats" className="bg-card divide-border divide-y rounded-2xl border">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center gap-1 pr-1">
              <button
                type="button"
                onClick={() => open(row)}
                className="hover:bg-muted/60 focus-visible:ring-ring/50 press flex min-h-14 min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-2xl py-2 pl-3 text-left outline-none focus-visible:ring-3"
              >
                <BotAvatar id={row.botId} name={row.botName} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{row.title}</span>
                  <span className="text-muted-foreground truncate text-xs">
                    {row.main ? "Main chat" : row.botName} · {formatWhen(row.at)}
                  </span>
                </span>
              </button>
              {!row.main && (
                <ConfirmDialog
                  title="Delete this chat?"
                  warning="The chat and all its messages are removed. This can't be undone."
                  onConfirm={async () => {
                    await sessions.remove(row.id);
                  }}
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    aria-label={`Delete ${row.title}`}
                  >
                    <Trash2Icon />
                  </Button>
                </ConfirmDialog>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
