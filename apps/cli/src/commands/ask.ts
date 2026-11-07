/**
 * `spriessen ask`: send one message into a chat and wait for the turn to
 * settle. In a terminal the turn plays out live (render/follow.ts): tool
 * calls as they finish, the reply streamed as it is written. Into a pipe
 * only the reply's words reach stdout; `--json` prints the entries. A card
 * that needs the owner goes to stderr with the command that answers it,
 * and ask keeps waiting (the web, the phone or another terminal can
 * approve) until `--timeout`. ctrl-c leaves the bot working and says where
 * the reply will land.
 */
import type { ProfileInfo, TranscriptEntry } from "@spriessen/contracts";
import { boolFlag, numberFlag, stringFlag, type Parsed } from "../args.ts";
import type { Api } from "../client/http.ts";
import {
  connectLink,
  watchSession,
  type SessionRef,
  type SessionSnapshot,
} from "../client/session.ts";
import { createFollower, replyText } from "../render/follow.ts";
import { paintFor, shortId } from "../render/out.ts";
import { cardWords } from "../render/words.ts";
import { apiFor, pickBot, pickTarget } from "./context.ts";

/** All of stdin, as text (`ask -`, or `ask` with something piped in). */
const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
};

/** The message `ask` sends: its words, or stdin for `-` or a pipe. */
export const askText = async (
  typed: string,
  stdinIsTerminal: boolean,
  read: () => Promise<string> = readStdin,
): Promise<string> =>
  typed === "-" || (typed === "" && !stdinIsTerminal) ? (await read()).trim() : typed;

/** Entries after the one our input produced, once nothing is running any more. */
export const settledAfter = (
  snapshot: SessionSnapshot,
  text: string,
  since: number,
): readonly TranscriptEntry[] | undefined => {
  const index = snapshot.transcript.findIndex(
    (entry) => entry.kind === "input" && entry.text === text && entry.id > since,
  );
  if (index < 0 || snapshot.phase === "working" || snapshot.pending !== null) return undefined;
  const after = snapshot.transcript.slice(index + 1);
  const answered = after.some((entry) => entry.kind === "output" && !entry.streaming);
  return answered || snapshot.lastError !== null || snapshot.phase === "error" ? after : undefined;
};

/** Our input's entry id, once the transcript shows it. */
const inputIdOf = (snapshot: SessionSnapshot, text: string, since: number): number | undefined =>
  snapshot.transcript.find(
    (entry) => entry.kind === "input" && entry.text === text && entry.id > since,
  )?.id;

class Detached extends Error {}

interface Turn {
  readonly after: readonly TranscriptEntry[];
  readonly error: string | null;
  readonly model: string | null;
}

/** Send `text` once the chat has loaded; settle when the turn does. */
const runTurn = (
  ref: SessionRef,
  text: string,
  bot: ProfileInfo,
  timeoutMs: number,
  onProgress: (snapshot: SessionSnapshot, inputId: number) => void,
): Promise<Turn> =>
  new Promise<Turn>((resolve, reject) => {
    let since = -1;
    let sent = false;
    let carded: string | undefined;
    let stop = (): void => undefined;
    const finish = (settle: () => void): void => {
      clearTimeout(timer);
      process.off("SIGINT", detach);
      stop();
      settle();
    };
    const timer = setTimeout(
      () =>
        finish(() => reject(new Error("timed out waiting for the reply (the bot keeps going)"))),
      timeoutMs,
    );
    const detach = (): void => finish(() => reject(new Detached()));
    process.once("SIGINT", detach);
    stop = watchSession(ref, (snapshot) => {
      if (!snapshot.loaded) return;
      if (!sent) {
        sent = true;
        since = snapshot.transcript.at(-1)?.id ?? -1;
        ref.input({ text }).catch((cause: unknown) => finish(() => reject(cause)));
        return;
      }
      const inputId = inputIdOf(snapshot, text, since);
      if (inputId !== undefined) onProgress(snapshot, inputId);
      if (snapshot.pending !== null && snapshot.pending.callId !== carded) {
        carded = snapshot.pending.callId;
        announceCard(bot, snapshot.pending);
      }
      const done = settledAfter(snapshot, text, since);
      if (done !== undefined)
        finish(() => resolve({ after: done, error: snapshot.lastError, model: snapshot.model }));
    });
  });

const announceCard = (bot: ProfileInfo, pending: NonNullable<SessionSnapshot["pending"]>) => {
  const paint = paintFor(process.stderr);
  const words = cardWords(pending);
  const hint = words.hint !== null ? ` (${words.hint})` : "";
  process.stderr.write(
    `\n${paint.amber("●")} ${paint.bold(`${bot.name} wants to ${words.action}`)}${hint}\n` +
      paint.dim(`  ${words.risk}\n`) +
      `  waiting for you: spriessen approve ${words.callId}  |  spriessen deny ${words.callId}\n` +
      paint.dim("  (or answer it in the web app or the terminal UI)\n"),
  );
};

/** Where to say it: `--new` makes a fresh chat with the bot; else --chat / --bot / main. */
const targetOf = async (api: Api, parsed: Parsed) => {
  if (!boolFlag(parsed, "new")) return pickTarget(api, parsed);
  if (stringFlag(parsed, "chat") !== undefined) {
    throw new Error("--new and --chat pull different ways; use one");
  }
  const bot = await pickBot(api, stringFlag(parsed, "bot"));
  const made = await api.createSession(bot.id);
  process.stderr.write(
    paintFor(process.stderr).dim(
      `New chat ${shortId(made.id)} with ${bot.name}. Continue it: spriessen ask --chat ${shortId(made.id)} "…"\n`,
    ),
  );
  return { bot, chatId: made.id };
};

const USAGE =
  'usage: spriessen ask "what to say" [--bot <name>] [--chat <id> | --new] (or pipe it in: … | spriessen ask -)';

export const ask = async (parsed: Parsed): Promise<number> => {
  const text = await askText(
    parsed.positionals.slice(1).join(" ").trim(),
    process.stdin.isTTY === true,
  );
  if (text === "") throw new Error(USAGE);
  const api = apiFor(parsed);
  const { bot, chatId } = await targetOf(api, parsed);
  const json = boolFlag(parsed, "json");
  const live = process.stdout.isTTY === true && !json;
  const follower = createFollower(bot.name, paintFor());
  const link = await connectLink(api.server, api.cookie ?? "");
  const ref = await link.open(chatId);
  try {
    const turn = await runTurn(
      ref,
      text,
      bot,
      (numberFlag(parsed, "timeout") ?? 600) * 1000,
      (snapshot, inputId) => {
        if (live) process.stdout.write(follower.feed(snapshot.transcript, inputId));
      },
    );
    if (turn.error !== null) {
      const paint = paintFor(process.stderr);
      console.error(paint.red(turn.error));
      if (turn.model === null) {
        console.error(paint.dim("Set the model new chats start on: spriessen models default <id>"));
      }
    }
    if (json) console.log(JSON.stringify(turn.after, null, 2));
    else if (!live) {
      const reply = replyText(turn.after);
      if (reply !== "") console.log(reply);
    }
    // A turn that ended on an error with no reply is a failed ask (exit 1).
    return turn.error !== null && !turn.after.some((entry) => entry.kind === "output") ? 1 : 0;
  } catch (cause) {
    if (!(cause instanceof Detached)) throw cause;
    process.stderr.write(
      `\nLeft ${bot.name} working. The reply will be in the chat: spriessen chats show ${shortId(chatId)}\n`,
    );
    return 130;
  } finally {
    ref.release();
    link.close();
  }
};
