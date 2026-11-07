/**
 * Running a slash command (slash.ts) in the TUI: branching and editing open
 * the new chat, /test saves your last message as a behaviour test, /bot
 * switches bots. Every outcome lands on the notice line.
 */
import { useCallback } from "react";
import type { Api } from "../client/http.ts";
import type { Chat } from "./use-chat.ts";
import type { Crew } from "./use-crew.ts";
import { lastOwnerMessage, lastReply, SLASH_HELP, type Slash } from "./slash.ts";

export type SlashDeps = {
  readonly api: Api;
  readonly chat: Chat;
  readonly crew: Crew;
  readonly botId: string | undefined;
  readonly chatId: string | undefined;
  readonly setBotId: (id: string) => void;
  readonly newChat: () => void;
  readonly openChat: (bot: string, chat: string) => void;
  readonly setDraft: (text: string) => void;
  readonly notice: (text: string) => void;
  readonly report: (work: Promise<unknown>, done?: string) => void;
};

export const useSlash = (deps: SlashDeps): ((slash: Slash) => void) => {
  const { api, chat, crew, botId, chatId, setBotId, newChat, openChat, setDraft, notice, report } =
    deps;
  return useCallback(
    (slash: Slash) => {
      const transcript = chat.snapshot.transcript;
      const mine = lastOwnerMessage(transcript);
      const open = (made: { id: string }): void => {
        if (botId !== undefined) openChat(botId, made.id);
      };
      switch (slash.kind) {
        case "help":
          return notice(SLASH_HELP);
        case "new":
          return newChat();
        case "stop":
          return report(chat.stop(), "Stopped.");
        case "bot": {
          const needle = slash.name.toLocaleLowerCase("en");
          const bot = crew.bots.find((candidate) =>
            candidate.name.toLocaleLowerCase("en").startsWith(needle),
          );
          return bot === undefined ? notice(`No bot called ${slash.name}.`) : setBotId(bot.id);
        }
        case "edit":
          if (mine === undefined || chatId === undefined)
            return notice("You haven't said anything here yet.");
          // Bare /edit puts your last message in the composer to change.
          if (slash.text === "") return setDraft(`/edit ${mine.text}`);
          return report(
            api.branch(chatId, { at: mine.id, mode: "edit", text: slash.text }).then(open),
            "Sent your edit in a new chat. The old one is unchanged.",
          );
        case "branch": {
          const reply = lastReply(transcript);
          if (reply === undefined || chatId === undefined)
            return notice("There's no reply to continue from yet.");
          return report(
            api.branch(chatId, { at: reply, mode: "from" }).then(open),
            "Continuing from the last reply in a new chat.",
          );
        }
        case "test":
          if (mine === undefined || chatId === undefined)
            return notice("You haven't said anything here yet.");
          return report(
            api.saveEval(chatId, mine.id),
            "Saved as a test. Run it with: spriessen tests run",
          );
        case "unknown":
          return notice(`There's no /${slash.name}. ${SLASH_HELP}`);
      }
    },
    [api, chat, crew.bots, botId, chatId, setBotId, newChat, openChat, setDraft, notice, report],
  );
};
