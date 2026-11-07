/**
 * What every client command starts from: which server, the saved session
 * cookie for it (a cookie saved for another server is never sent), and how
 * things are named on the command line. One rule everywhere, the TUI's
 * `/bot` included: a bot is its id, its name (any case) or the start of its
 * name when only one bot starts that way; a chat or a task is its id or
 * the start of its id (lists print the first 8 characters).
 */
import type { ProfileInfo, SessionInfo, TaskRow } from "@spriessen/contracts";
import { stringFlag, type Parsed } from "../args.ts";
import { createApi, type Api } from "../client/http.ts";
import { readCredentials, serverOf } from "../config.ts";

export const apiFor = (parsed: Parsed): Api => {
  const server = serverOf(stringFlag(parsed, "server"));
  const saved = readCredentials();
  return createApi(server, saved?.server === server ? saved.cookie : undefined);
};

/** A refusal that names what exists, so the next try can be right. */
export class NoMatch extends Error {}

export const NO_BOTS =
  "There are no bots yet. Create one with `spriessen bots new <name>` (or in the web app)";

/** The bot `wanted` names among `bots`: id, exact name, then a unique name prefix. */
export const matchBot = (bots: readonly ProfileInfo[], wanted: string): ProfileInfo => {
  const needle = wanted.toLocaleLowerCase("en");
  const exact =
    bots.find((bot) => bot.id === wanted) ??
    bots.find((bot) => bot.name.toLocaleLowerCase("en") === needle);
  if (exact !== undefined) return exact;
  const starts = bots.filter((bot) => bot.name.toLocaleLowerCase("en").startsWith(needle));
  if (starts.length === 1) return starts[0] as ProfileInfo;
  const names = (starts.length > 1 ? starts : bots).map((bot) => bot.name).join(", ");
  throw new NoMatch(
    starts.length > 1
      ? `${wanted} could be any of ${names}; say more of the name`
      : `No bot is called ${wanted} (bots: ${names || "none yet"})`,
  );
};

/** The item whose id is `wanted` or starts with it (at least 4 characters). */
export const matchId = <T extends { readonly id: string }>(
  items: readonly T[],
  wanted: string,
  what: string,
  list: string,
): T => {
  const exact = items.find((item) => item.id === wanted);
  if (exact !== undefined) return exact;
  const starts = wanted.length >= 4 ? items.filter((item) => item.id.startsWith(wanted)) : [];
  if (starts.length === 1) return starts[0] as T;
  throw new NoMatch(
    starts.length > 1
      ? `More than one ${what} starts with ${wanted}; give more of the id`
      : `No ${what} has the id ${wanted} (see: ${list})`,
  );
};

/** The live (not archived) bots. */
export const liveBots = async (api: Api): Promise<ProfileInfo[]> =>
  (await api.profiles()).filter((bot) => bot.archivedAt === null);

/** The bot a command means: `--bot <name|id>`, else the main bot, else the first one. */
export const pickBot = async (api: Api, wanted: string | undefined): Promise<ProfileInfo> => {
  const bots = await liveBots(api);
  if (bots.length === 0) throw new NoMatch(NO_BOTS);
  if (wanted !== undefined) return matchBot(bots, wanted);
  const { profileId } = await api.main();
  return bots.find((bot) => bot.id === profileId) ?? (bots[0] as ProfileInfo);
};

/** The bot `--bot` names, or undefined when the flag is absent (every bot). */
export const botFilter = async (api: Api, parsed: Parsed): Promise<ProfileInfo | undefined> => {
  const name = stringFlag(parsed, "bot");
  return name === undefined ? undefined : pickBot(api, name);
};

/** The chat a command means: an id (or its start) among the owner's chats. */
export const findChat = async (api: Api, wanted: string): Promise<SessionInfo> =>
  matchId(await api.sessions(), wanted, "chat", "spriessen chats");

/** The task an id (or its start) names. */
export const findTask = async (api: Api, wanted: string): Promise<TaskRow> =>
  matchId(await api.tasks(), wanted, "task", "spriessen tasks");

/** Bot names by id, for lists that span the crew. */
export const namesOf = async (api: Api): Promise<Map<string, string>> =>
  new Map((await api.profiles()).map((bot) => [bot.id, bot.name]));

/**
 * Where a command talks: `--chat <id>` (its bot follows the chat), else
 * `--bot`'s (or the main bot's) main chat.
 */
export const pickTarget = async (
  api: Api,
  parsed: Parsed,
): Promise<{ bot: ProfileInfo; chatId: string }> => {
  const chat = stringFlag(parsed, "chat");
  if (chat !== undefined) {
    const found = await findChat(api, chat);
    const bots = await liveBots(api);
    const bot = bots.find((candidate) => candidate.id === found.profile);
    if (bot === undefined) throw new NoMatch(`That chat's bot is archived or gone`);
    return { bot, chatId: found.id };
  }
  const bot = await pickBot(api, stringFlag(parsed, "bot"));
  return { bot, chatId: (await api.mainChat(bot.id)).id };
};
