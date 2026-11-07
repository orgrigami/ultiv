/**
 * `spriessen chats`: past chats, newest first, with their short ids;
 * `chats show` prints one (the bot's main chat when no id is given) in the
 * words `ask` uses; `chats new` starts a fresh chat and prints its id, to
 * continue with `ask --chat` or `chat --chat`.
 */
import type { SessionInfo, TranscriptEntry } from "@spriessen/contracts";
import { numberFlag, stringFlag, type Parsed } from "../args.ts";
import type { Api } from "../client/http.ts";
import { connectLink, watchSession, type SessionSnapshot } from "../client/session.ts";
import { ago, clip, count, paintFor, print, shortId } from "../render/out.ts";
import { entryLines, machineryLine } from "../render/words.ts";
import { apiFor, botFilter, findChat, namesOf, pickBot } from "./context.ts";

/** The kinds the owner reads as chats (not bot-to-bot threads or task conversations). */
const OWNER_KINDS = new Set(["main", "session"]);

const list = async (parsed: Parsed): Promise<void> => {
  const api = apiFor(parsed);
  const [bot, names] = await Promise.all([botFilter(api, parsed), namesOf(api)]);
  const limit = numberFlag(parsed, "limit") ?? 20;
  const rows = (await api.sessions(bot?.id))
    .filter((row) => OWNER_KINDS.has(row.kind))
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
    .slice(0, limit);
  const paint = paintFor();
  print(parsed, rows, () =>
    rows.length === 0
      ? ["No chats yet. Start one: spriessen"]
      : [
          ...rows.map((row) => {
            const who = bot === undefined ? `${names.get(row.profile) ?? "?"} · ` : "";
            const main = row.kind === "main" ? paint.amber(" (main)") : "";
            return `${paint.dim(shortId(row.id).padEnd(13))}  ${ago(row.lastMessageAt).padEnd(8)} ${who}${clip(row.title || "New chat", 60)}${main}`;
          }),
          "",
          paint.dim("Read one: spriessen chats show <id> · open it: spriessen chat --chat <id>"),
        ],
  );
};

/** One chat's snapshot, once the server has loaded it. */
export const readChat = async (api: Api, chatId: string): Promise<SessionSnapshot> => {
  const link = await connectLink(api.server, api.cookie ?? "");
  const ref = await link.open(chatId);
  try {
    return await new Promise<SessionSnapshot>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the chat took too long to load")), 15_000);
      let stop = (): void => undefined;
      stop = watchSession(ref, (snapshot) => {
        if (!snapshot.loaded) return;
        clearTimeout(timer);
        queueMicrotask(() => stop());
        resolve(snapshot);
      });
    });
  } finally {
    ref.release();
    link.close();
  }
};

/** The visible lines of a transcript; with `last`, from your last `last` messages on. */
export const transcriptLines = (
  entries: readonly TranscriptEntry[],
  bot: string,
  last?: number,
): string[] => {
  let shown = entries;
  if (last !== undefined) {
    const starts = entries
      .map((entry, index) =>
        entry.kind === "input" && machineryLine(entry) === undefined ? index : -1,
      )
      .filter((index) => index >= 0);
    const from = starts.at(-Math.max(1, last));
    shown = from === undefined ? entries : entries.slice(from);
  }
  return shown.flatMap((entry) => {
    const lines = entryLines(entry, bot);
    return entry.kind === "input" || entry.kind === "output" ? ["", ...lines] : lines;
  });
};

const chatOf = async (api: Api, parsed: Parsed): Promise<SessionInfo> => {
  const wanted = parsed.positionals[2];
  if (wanted !== undefined) return findChat(api, wanted);
  const bot = await pickBot(api, stringFlag(parsed, "bot"));
  return api.mainChat(bot.id);
};

const show = async (parsed: Parsed): Promise<number> => {
  const api = apiFor(parsed);
  const chat = await chatOf(api, parsed);
  const [snapshot, names] = await Promise.all([readChat(api, chat.id), namesOf(api)]);
  const bot = names.get(chat.profile) ?? "Bot";
  const paint = paintFor();
  print(parsed, snapshot.transcript, () => [
    paint.bold(chat.title || "New chat"),
    paint.dim(
      `${bot} · ${shortId(chat.id)} · ${count(snapshot.transcript.filter((e) => e.kind === "input").length, "message")} from you` +
        (snapshot.model !== null ? ` · ${snapshot.model}` : "") +
        (snapshot.phase === "working" ? " · working now" : ""),
    ),
    ...transcriptLines(snapshot.transcript, bot, numberFlag(parsed, "last")),
    ...(snapshot.pending !== null
      ? [
          "",
          paint.amber(`A card is waiting: spriessen approve ${shortId(snapshot.pending.callId)}`),
        ]
      : []),
  ]);
  return 0;
};

const create = async (parsed: Parsed): Promise<void> => {
  const api = apiFor(parsed);
  const bot = await pickBot(api, stringFlag(parsed, "bot"));
  const made = await api.createSession(bot.id);
  if (parsed.flags.get("json") === true) return console.log(JSON.stringify(made));
  console.log(made.id);
  process.stderr.write(
    paintFor(process.stderr).dim(
      `A new chat with ${bot.name}. Say something: spriessen ask --chat ${shortId(made.id)} "…"\n`,
    ),
  );
};

export const chatsCommand = async (parsed: Parsed): Promise<number | void> => {
  const sub = parsed.positionals[1];
  if (sub === undefined) return list(parsed);
  if (sub === "show") return show(parsed);
  if (sub === "new") return create(parsed);
  throw new Error(
    `\`spriessen chats ${sub}\` isn't a thing; try: chats, chats show <id>, chats new`,
  );
};
