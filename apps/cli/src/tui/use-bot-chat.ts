/**
 * Which bot and which of its chats the TUI has open: the chat `--chat`
 * named, else the main chat of the bot `--bot` named, else the main bot's
 * main chat. Switching bots opens that bot's main chat; `newChat` starts a
 * fresh one; `openChat` jumps anywhere (Needs you, the chat picker, a
 * branch).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Api } from "../client/http.ts";
import type { Crew } from "./use-crew.ts";

export interface Wanted {
  /** A bot id or name (`--bot`, or the chat's bot for `--chat`). */
  readonly bot?: string | undefined;
  /** A chat id (`--chat`, resolved before the UI loads). */
  readonly chat?: string | undefined;
}

export interface BotChat {
  readonly botId: string | undefined;
  readonly chatId: string | undefined;
  readonly setBotId: (id: string) => void;
  readonly newChat: () => void;
  readonly openChat: (bot: string, chat: string) => void;
}

export const useBotChat = (
  api: Api,
  crew: Crew,
  wanted: Wanted,
  onError: (cause: unknown) => void,
): BotChat => {
  const [botId, setBotIdRaw] = useState<string | undefined>(undefined);
  const [chatId, setChatId] = useState<string | undefined>(wanted.chat);
  // A pick that came with its chat (--chat, openChat) keeps it; a plain bot switch opens the main chat.
  const keepChat = useRef(wanted.chat !== undefined);
  useEffect(() => {
    if (botId !== undefined || crew.bots.length === 0) return;
    const needle = wanted.bot?.toLocaleLowerCase("en");
    const pick =
      crew.bots.find(
        (bot) => bot.id === wanted.bot || bot.name.toLocaleLowerCase("en") === needle,
      ) ??
      crew.bots.find((bot) => bot.id === crew.mainId) ??
      crew.bots[0];
    if (pick !== undefined) setBotIdRaw(pick.id);
  }, [crew.bots, crew.mainId, botId, wanted.bot]);
  useEffect(() => {
    if (botId === undefined) return;
    if (keepChat.current) {
      keepChat.current = false;
      return;
    }
    api.mainChat(botId).then((chat) => setChatId(chat.id), onError);
  }, [api, botId, onError]);
  const setBotId = useCallback((id: string) => setBotIdRaw(id), []);
  const newChat = useCallback(() => {
    if (botId === undefined) return;
    api.createSession(botId).then((made) => setChatId(made.id), onError);
  }, [api, botId, onError]);
  const openChat = useCallback(
    (bot: string, chat: string) => {
      if (bot !== botId) keepChat.current = true;
      setBotIdRaw(bot);
      setChatId(chat);
    },
    [botId],
  );
  return { botId, chatId, setBotId, newChat, openChat };
};
