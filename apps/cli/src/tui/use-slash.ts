/**
 * Running a slash command (slash.ts) in the TUI: branching and editing open
 * the new chat, /test saves your last message as a behaviour test, /bot,
 * /chats and /model switch (bare: open the picker), /copy puts the last
 * reply on the clipboard (OSC 52, so it works over SSH too), /open shows
 * the chat in the browser. Every outcome lands on the notice line.
 */
import type { Api } from "../client/http.ts";
import { matchBot } from "../commands/context.ts";
import { openUrl } from "../open-url.ts";
import type { Chat } from "./use-chat.ts";
import type { Crew } from "./use-crew.ts";
import { lastOwnerMessage, lastReply, SLASH_HELP, type Slash } from "./slash.ts";

export type Overlay = "bots" | "chats" | "models" | "help";

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
  readonly openOverlay: (overlay: Overlay) => void;
  /** Copy to the terminal's clipboard; false when the terminal can't. */
  readonly copy: (text: string) => boolean;
};

const NOT_YET = "You haven't said anything here yet.";

/** The switches: /bot, /model (bare opens the picker). */
const switchTo = (deps: SlashDeps, slash: Extract<Slash, { kind: "bot" | "model" }>): void => {
  const { api, chat, crew, setBotId, notice, report, openOverlay } = deps;
  if (slash.kind === "bot") {
    if (slash.name === "") return openOverlay("bots");
    try {
      return setBotId(matchBot(crew.bots, slash.name).id);
    } catch (cause) {
      return notice(`${(cause as Error).message}.`);
    }
  }
  if (slash.id === "") return openOverlay("models");
  report(
    api.models().then((payload) => {
      const model = payload.models.find((candidate) => candidate.id === slash.id);
      if (model === undefined)
        throw new Error(`there's no model called ${slash.id}; /model lists them`);
      return chat.configure(model);
    }),
    `This chat now runs on ${slash.id}.`,
  );
};

/** The message actions: /edit, /branch, /test, /copy. */
const onMessages = (
  deps: SlashDeps,
  slash: Extract<Slash, { kind: "edit" | "branch" | "test" | "copy" }>,
): void => {
  const { api, chat, botId, chatId, openChat, setDraft, notice, report, copy } = deps;
  const transcript = chat.snapshot.transcript;
  const mine = lastOwnerMessage(transcript);
  const reply = lastReply(transcript);
  const open = (made: { id: string }): void => {
    if (botId !== undefined) openChat(botId, made.id);
  };
  switch (slash.kind) {
    case "edit":
      if (mine === undefined || chatId === undefined) return notice(NOT_YET);
      // Bare /edit puts your last message in the composer to change.
      if (slash.text === "") return setDraft(`/edit ${mine.text}`);
      return report(
        api.branch(chatId, { at: mine.id, mode: "edit", text: slash.text }).then(open),
        "Sent your edit in a new chat. The old one is unchanged.",
      );
    case "branch":
      if (reply === undefined || chatId === undefined) {
        return notice("There's no reply to continue from yet.");
      }
      return report(
        api.branch(chatId, { at: reply.id, mode: "from" }).then(open),
        "Continuing from the last reply in a new chat.",
      );
    case "test":
      if (mine === undefined || chatId === undefined) return notice(NOT_YET);
      return report(
        api.saveEval(chatId, mine.id),
        "Saved as a test. Run it with: spriessen tests run",
      );
    case "copy":
      if (reply === undefined) return notice("There's no reply to copy yet.");
      return notice(
        copy(reply.text)
          ? "Copied the last reply."
          : "This terminal doesn't take clipboard writes (OSC 52); try `spriessen chats show`.",
      );
  }
};

export const runSlash = (deps: SlashDeps, slash: Slash): void => {
  const { api, chat, chatId, newChat, notice, report, openOverlay } = deps;
  switch (slash.kind) {
    case "help":
      return openOverlay("help");
    case "new":
      return newChat();
    case "stop":
      return report(chat.stop(), "Stopped.");
    case "retry":
      return report(
        chat.retryQueued(),
        chat.snapshot.queued.length > 0 ? "Sending the queued messages." : "Nothing is queued.",
      );
    case "chats":
      return openOverlay("chats");
    case "open": {
      const url = `${api.server}/c/${chatId ?? ""}`;
      return notice(openUrl(url) ? `Opened ${url}` : `Open it at ${url}`);
    }
    case "bot":
    case "model":
      return switchTo(deps, slash);
    case "edit":
    case "branch":
    case "test":
    case "copy":
      return onMessages(deps, slash);
    case "unknown":
      return notice(`There's no /${slash.name}. ${SLASH_HELP}`);
  }
};

/** The runner for this render's state (app.tsx keeps it in a ref for the composer). */
export const useSlash =
  (deps: SlashDeps): ((slash: Slash) => void) =>
  (slash) =>
    runSlash(deps, slash);
