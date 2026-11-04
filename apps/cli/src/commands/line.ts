/**
 * The scriptable commands: plain lines on stdout (`--json` for machines),
 * errors on stderr. `ask` sends one message into a chat and prints what the
 * bot said and did after it, once the turn settles; a card that needs the
 * owner is printed with the command that answers it, and `ask` keeps
 * waiting (the web or another terminal can approve) until `--timeout`.
 */
import type { TranscriptEntry } from "@spriessen/contracts";
import { boolFlag, numberFlag, stringFlag, type Parsed } from "../args.ts";
import type { ApprovalRow } from "../client/http.ts";
import { connectLink, watchSession, type SessionSnapshot } from "../client/session.ts";
import { cardWords, entryLines } from "../render/words.ts";
import { apiFor, pickBot, pickChat } from "./context.ts";

const print = (parsed: Parsed, value: unknown, lines: () => string[]): void => {
  if (boolFlag(parsed, "json")) console.log(JSON.stringify(value, null, 2));
  else for (const line of lines()) console.log(line);
};

export const bots = async (parsed: Parsed): Promise<void> => {
  const api = apiFor(parsed);
  const [all, main] = await Promise.all([api.profiles(), api.main()]);
  const live = all.filter((bot) => bot.archivedAt === null);
  print(parsed, live, () =>
    live.map(
      (bot) =>
        `${bot.id === main.profileId ? "*" : " "} ${bot.name.padEnd(20)} ${bot.description.slice(0, 60)}`,
    ),
  );
};

export const chats = async (parsed: Parsed): Promise<void> => {
  const api = apiFor(parsed);
  const botName = stringFlag(parsed, "bot");
  const bot = botName !== undefined ? await pickBot(api, botName) : undefined;
  const rows = (await api.sessions(bot?.id)).sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  print(parsed, rows, () =>
    rows.map(
      (row) =>
        `${row.id}  ${new Date(row.lastMessageAt).toISOString().slice(0, 16).replace("T", " ")}  ${row.title}`,
    ),
  );
};

const approvalLines = (rows: readonly ApprovalRow[], names: Map<string, string>): string[] =>
  rows.map((row) => {
    const words = cardWords(row);
    const hint = words.hint !== null ? ` (${words.hint})` : "";
    return `${row.callId}  ${names.get(row.profile) ?? row.profile} wants to ${words.action}${hint}`;
  });

export const needs = async (parsed: Parsed): Promise<void> => {
  const api = apiFor(parsed);
  const [rows, tasks, bots, extra] = await Promise.all([
    api.approvals(),
    api.tasks(),
    api.profiles(),
    api.needsYou(),
  ]);
  const names = new Map(bots.map((bot) => [bot.id, bot.name]));
  const failed = tasks.filter((task) => task.status === "failed");
  const tidy = extra.tidy.reduce((sum, row) => sum + row.open, 0);
  print(parsed, { approvals: rows, failed, extra }, () => {
    const lines = approvalLines(rows, names);
    for (const task of failed) lines.push(`task ${task.id} failed: ${task.error ?? "no reason"}`);
    if (tidy > 0) lines.push(`${tidy} memory proposal(s) to review (web: Needs you)`);
    if ((extra.parked ?? []).length > 0) lines.push(`${extra.parked?.length} parked task(s)`);
    if (lines.length === 0) lines.push("Nothing needs you.");
    else if (rows.length > 0) lines.push("", "Answer with: spriessen approve <id> | deny <id>");
    return lines;
  });
};

export const decide = async (parsed: Parsed, approved: boolean): Promise<void> => {
  const callId = parsed.positionals[1];
  if (callId === undefined)
    throw new Error(`usage: spriessen ${approved ? "approve" : "deny"} <id>`);
  const api = apiFor(parsed);
  const row = (await api.approvals()).find((candidate) => candidate.callId === callId);
  if (row === undefined)
    throw new Error(`nothing is waiting with id ${callId} (see: spriessen needs)`);
  const always = approved && boolFlag(parsed, "always");
  if (always && cardWords(row).always === null) {
    throw new Error("this card can never be always-allowed; approve it once instead");
  }
  const result = await api.decide(row, approved, always);
  if (!result.ok) throw new Error("the server did not take the decision (it may have moved on)");
  console.log(
    approved ? (always ? "Approved, and saved as always allowed." : "Approved.") : "Denied.",
  );
};

/** Entries after the one our input produced, once nothing is running any more. */
const settledAfter = (snapshot: SessionSnapshot, text: string, since: number) => {
  const index = snapshot.transcript.findIndex(
    (entry) => entry.kind === "input" && entry.text === text && entry.id > since,
  );
  if (index < 0 || snapshot.phase === "working" || snapshot.pending !== null) return undefined;
  const after = snapshot.transcript.slice(index + 1);
  const answered = after.some((entry) => entry.kind === "output" && !entry.streaming);
  return answered || snapshot.lastError !== null || snapshot.phase === "error" ? after : undefined;
};

export const ask = async (parsed: Parsed): Promise<number> => {
  const text = parsed.positionals.slice(1).join(" ").trim();
  if (text === "")
    throw new Error('usage: spriessen ask "what to say" [--bot <name>] [--chat <id>]');
  const api = apiFor(parsed);
  const bot = await pickBot(api, stringFlag(parsed, "bot"));
  const chatId = await pickChat(api, bot, stringFlag(parsed, "chat"));
  const timeoutMs = (numberFlag(parsed, "timeout") ?? 600) * 1000;
  const link = await connectLink(api.server, api.cookie ?? "");
  const ref = await link.open(chatId);
  try {
    let failed = false;
    const after = await new Promise<readonly TranscriptEntry[]>((resolve, reject) => {
      let since = -1;
      let sent = false;
      let carded: string | undefined;
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for the reply")),
        timeoutMs,
      );
      const stop = watchSession(ref, (snapshot) => {
        if (!snapshot.loaded) return;
        if (!sent) {
          sent = true;
          since = snapshot.transcript.at(-1)?.id ?? -1;
          ref.input({ text }).catch(reject);
          return;
        }
        if (snapshot.pending !== null && snapshot.pending.callId !== carded) {
          carded = snapshot.pending.callId;
          const words = cardWords(snapshot.pending);
          console.error(
            `${bot.name} wants to ${words.action}${words.hint !== null ? ` (${words.hint})` : ""}`,
          );
          console.error(
            `  waiting for you: spriessen approve ${words.callId} | deny ${words.callId}`,
          );
        }
        const done = settledAfter(snapshot, text, since);
        if (done === undefined) return;
        clearTimeout(timer);
        stop();
        if (snapshot.lastError !== null) {
          failed = !done.some((entry) => entry.kind === "output");
          console.error(snapshot.lastError);
        }
        resolve(done);
      });
    });
    print(parsed, after, () => after.flatMap((entry) => entryLines(entry, bot.name)));
    // A turn that ended on an error with no reply is a failed ask (exit 1).
    return failed ? 1 : 0;
  } finally {
    ref.release();
    link.close();
  }
};
