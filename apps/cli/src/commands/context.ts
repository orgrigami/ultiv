/**
 * What every client command starts from: which server, the saved session
 * cookie for it (a cookie saved for another server is never sent), and how
 * a bot is named on the command line — its name (case-insensitive), its id,
 * or nothing for the main bot.
 */
import type { ProfileInfo } from "@spriessen/contracts";
import { stringFlag, type Parsed } from "../args.ts";
import { createApi, type Api } from "../client/http.ts";
import { readCredentials, serverOf } from "../config.ts";

export const apiFor = (parsed: Parsed): Api => {
  const server = serverOf(stringFlag(parsed, "server"));
  const saved = readCredentials();
  return createApi(server, saved?.server === server ? saved.cookie : undefined);
};

/** The bot a command means: `--bot <name|id>`, else the main bot, else the only one. */
export const pickBot = async (api: Api, wanted: string | undefined): Promise<ProfileInfo> => {
  const bots = (await api.profiles()).filter((bot) => bot.archivedAt === null);
  if (bots.length === 0) throw new Error("no bots yet: create one in the web app first");
  if (wanted !== undefined) {
    const needle = wanted.toLocaleLowerCase("en");
    const found =
      bots.find((bot) => bot.id === wanted) ??
      bots.find((bot) => bot.name.toLocaleLowerCase("en") === needle);
    if (found === undefined) {
      throw new Error(`no bot named ${wanted} (bots: ${bots.map((bot) => bot.name).join(", ")})`);
    }
    return found;
  }
  const { profileId } = await api.main();
  return bots.find((bot) => bot.id === profileId) ?? (bots[0] as ProfileInfo);
};

/** The chat a command means: `--chat <id>`, else the bot's main chat. */
export const pickChat = async (
  api: Api,
  bot: ProfileInfo,
  chatId: string | undefined,
): Promise<string> => {
  if (chatId !== undefined) return chatId;
  return (await api.mainChat(bot.id)).id;
};
