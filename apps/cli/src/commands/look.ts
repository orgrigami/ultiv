/**
 * Reading what the crew knows and does on its own: `search` (the words
 * said in the bots' chats, grouped by bot, each hit with the chat to read),
 * `memory` (a bot's core lines and facts, by `#handle` — the same handle
 * the bot's own tools take), and `routines` (scheduled wake-ups and how the
 * last one went). Read-only: changing memory or routines stays in the web
 * app, where every change is reviewed.
 */
import type { CronJobInfo, MemoryFact } from "@spriessen/contracts";
import { boolFlag, numberFlag, stringFlag, type Parsed } from "../args.ts";
import { ago, clip, paintFor, print, shortId, when } from "../render/out.ts";
import { apiFor, botFilter, namesOf, pickBot } from "./context.ts";

const WHO: Readonly<Record<string, string>> = { owner: "owner", bot: "bot", tool: "tool" };

export const search = async (parsed: Parsed): Promise<void> => {
  const q = parsed.positionals.slice(1).join(" ").trim();
  if (q.length < 2) throw new Error('usage: spriessen search "words" [--bot <name>]');
  const who = stringFlag(parsed, "who");
  if (who !== undefined && WHO[who] === undefined) {
    throw new Error("--who takes owner, bot or tool");
  }
  const api = apiFor(parsed);
  const [bot, names] = await Promise.all([botFilter(api, parsed), namesOf(api)]);
  const since = stringFlag(parsed, "since");
  const until = stringFlag(parsed, "until");
  const limit = numberFlag(parsed, "limit");
  const found = await api.historySearch({
    q,
    ...(bot !== undefined ? { bot: bot.id } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(who !== undefined ? { who } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  const paint = paintFor();
  print(parsed, found, () => {
    if (found.groups.length === 0) return [`Nothing in the chats matches "${q}".`];
    const lines: string[] = [];
    for (const group of found.groups) {
      const name = names.get(group.profile) ?? group.profile;
      lines.push(paint.bold(name));
      for (const hit of group.hits) {
        const speaker = hit.role === "user" ? "you" : hit.role === "assistant" ? name : "tool";
        const at = hit.at > 0 ? ago(hit.at) : "";
        lines.push(
          `  ${paint.dim(shortId(hit.sessionId).padEnd(13))}  ${at.padEnd(8)} ${paint.dim(`${speaker}:`)} ${clip(hit.snippet, 90)}`,
        );
        if (hit.kind !== "main") {
          lines.push(paint.dim(`                 in ${clip(hit.sessionTitle || "a chat", 60)}`));
        }
      }
      lines.push("");
    }
    lines.push(paint.dim("Read the chat: spriessen chats show <id>"));
    return lines;
  });
};

const stars = (importance: number): string => "★".repeat(importance) + "☆".repeat(5 - importance);

/** Current facts, most important (then most recently confirmed) first, optionally filtered by words. */
export const factsShown = (
  facts: readonly MemoryFact[],
  find: string | undefined,
  all: boolean,
): MemoryFact[] => {
  const words = (find ?? "").toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return facts
    .filter((fact) => fact.status === "current")
    .filter((fact) => words.every((word) => fact.text.toLocaleLowerCase().includes(word)))
    .sort((a, b) => b.importance - a.importance || b.confirmedAt - a.confirmedAt)
    .slice(0, all ? undefined : 30);
};

export const memory = async (parsed: Parsed): Promise<void> => {
  const api = apiFor(parsed);
  const bot = await pickBot(api, stringFlag(parsed, "bot"));
  const store = await api.memory(bot.id);
  const facts = factsShown(store.facts, stringFlag(parsed, "find"), boolFlag(parsed, "all"));
  const current = store.facts.filter((fact) => fact.status === "current").length;
  const paint = paintFor();
  print(parsed, { core: store.core, facts }, () => {
    const lines: string[] = [paint.bold(`What ${bot.name} remembers`)];
    const core = [...store.core.owner, ...store.core.profile];
    if (core.length > 0) {
      lines.push("", paint.dim("Always in mind:"));
      for (const line of core) lines.push(`  ${line.pinned ? "📌 " : ""}${line.text}`);
    }
    lines.push("", paint.dim(`Facts (${facts.length} of ${current}):`));
    if (facts.length === 0) lines.push("  None yet.");
    for (const fact of facts) {
      const tag = fact.scope === "owner" ? paint.dim(" · about you") : "";
      lines.push(
        `  ${paint.dim(`#${shortId(fact.id)}`)} ${paint.amber(stars(fact.importance))} ${fact.text}${tag}`,
      );
    }
    if (store.openCount > 0) {
      lines.push("", `${store.openCount} suggested change(s) to review (web app: Needs you).`);
    }
    if (!boolFlag(parsed, "all") && facts.length < current) {
      lines.push(paint.dim('Every fact: --all · only some: --find "words"'));
    }
    return lines;
  });
};

const scheduleOf = (job: CronJobInfo): string =>
  job.once != null ? `once at ${when(job.once)}` : job.schedule;

export const routines = async (parsed: Parsed): Promise<void> => {
  const api = apiFor(parsed);
  const [bot, names] = await Promise.all([botFilter(api, parsed), namesOf(api)]);
  const jobs = await api.routines(bot?.id);
  const paint = paintFor();
  print(parsed, jobs, () =>
    jobs.length === 0
      ? ['No routines yet. Ask a bot to do something on a schedule ("every weekday at 8, …").']
      : jobs.flatMap((job) => {
          const mark = job.enabled ? paint.green("●") : paint.dim("○ off");
          const how = job.run === "task" ? "in the background" : "in its chat";
          const last = job.lastRunAt !== null ? `last ran ${ago(job.lastRunAt)}` : "hasn't run yet";
          return [
            `${mark} ${paint.bold(scheduleOf(job))}  ${names.get(job.profile) ?? job.profile}, ${how}`,
            `    ${clip(job.prompt, 90)}`,
            paint.dim(
              `    ${last}${job.fireCount !== undefined ? ` · ${job.fireCount} fire(s)` : ""}`,
            ),
            ...(job.lastError !== null ? [paint.red(`    last error: ${job.lastError}`)] : []),
          ];
        }),
  );
};
