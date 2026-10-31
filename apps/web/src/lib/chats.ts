/**
 * Past chats as one list: every bot's main chat and the extra chats you
 * started, newest first. Shared by the Past chats tab, the sidebar's Recents
 * and the quick switcher, so all three agree. DMs, rooms and task threads
 * are bot-to-bot plumbing and stay out.
 */
import type { ProfileInfo, SessionInfo } from "@ultiv/contracts";

export interface ChatRow {
  id: string;
  title: string;
  botId: string;
  botName: string;
  at: number;
  /** The bot's main chat; it opens on the Chat tab, not at /c/. */
  main: boolean;
}

export function chatTitle(session: Pick<SessionInfo, "kind" | "title">, botName: string): string {
  if (session.kind === "main") return `${botName} · main chat`;
  return session.title.trim() === "" ? "Untitled chat" : session.title;
}

export function pastChats(input: {
  sessions: readonly SessionInfo[];
  profiles: readonly ProfileInfo[];
  query?: string;
  limit?: number;
}): ChatRow[] {
  const names = new Map(input.profiles.map((bot) => [bot.id, bot.name]));
  const needle = (input.query ?? "").trim().toLowerCase();
  const rows = input.sessions
    .filter((session) => session.kind === "main" || session.kind === "session")
    .flatMap((session): ChatRow[] => {
      const botName = names.get(session.profile);
      if (botName === undefined) return [];
      return [
        {
          id: session.id,
          title: chatTitle(session, botName),
          botId: session.profile,
          botName,
          at: session.lastMessageAt,
          main: session.kind === "main",
        },
      ];
    })
    .filter(
      (row) =>
        needle === "" ||
        row.title.toLowerCase().includes(needle) ||
        row.botName.toLowerCase().includes(needle),
    )
    .sort((a, b) => b.at - a.at);
  return input.limit === undefined ? rows : rows.slice(0, input.limit);
}
