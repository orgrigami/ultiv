/**
 * What one bot may learn about its siblings: public profile facts only -
 * name, id, role, the persona's first line, contact rights both ways, tool
 * GROUPS and busy/idle. Never memory, vault, files, chats or tool inputs
 * (the sibling wall).
 */
import type { ProfileInfo } from "@spreissen/contracts";

export const ROLE_CHARS = 80;

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/** The role in one short clause (first sentence or line of the description). */
export const roleOf = (profile: ProfileInfo, max = ROLE_CHARS): string =>
  clip(profile.description.split(/\r?\n|(?<=[.!?])\s/)[0] ?? "", max);

export const personaFirstLine = (profile: ProfileInfo): string =>
  clip(profile.persona.split(/\r?\n/).find((line) => line.trim() !== "") ?? "", 160);

/** May `from` start a conversation with `to` (the mailbox's canInitiate rule)? */
export const mayInitiate = (from: ProfileInfo, to: ProfileInfo): boolean =>
  from.id !== to.id &&
  from.archivedAt === null &&
  to.archivedAt === null &&
  (from.policies.canInitiate.includes("*") || from.policies.canInitiate.includes(to.id));

const GROUP_WORDS: Record<string, string> = {
  web: "web",
  http: "web requests",
  memory: "memory",
  artifact: "files",
  schedule: "schedules",
  webhook: "webhooks",
  sensor: "watches",
  task: "background tasks",
  message: "messaging",
  room: "messaging",
  email: "email",
  connector: "connectors",
  bash: "scripts",
  codemode: "scripts",
  vault: "vault lookups",
};

/** Tool GROUP names from an allowlist (null = every tool). Never inputs. */
export const toolGroupsOf = (profile: ProfileInfo): string => {
  if (profile.toolAllowlist === null) return "all tools";
  const groups = new Set(
    profile.toolAllowlist.map((name) => GROUP_WORDS[name.split("_")[0] ?? name] ?? "other"),
  );
  return groups.size === 0 ? "no tools" : [...groups].sort().join(", ");
};

const distance = (a: string, b: string): number => {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j] ?? 0;
      row[j] = Math.min(
        above + 1,
        (row[j - 1] ?? 0) + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = above;
    }
  }
  return row[b.length] ?? 0;
};

/** A bot by id or name (case-insensitive), else up to three close names. */
export const findBot = (
  bots: readonly ProfileInfo[],
  wanted: string,
): { readonly bot: ProfileInfo } | { readonly close: string[] } => {
  const key = wanted.trim().toLowerCase();
  const bot = bots.find(
    (candidate) => candidate.id === wanted.trim() || candidate.name.toLowerCase() === key,
  );
  if (bot !== undefined) return { bot };
  const close = bots
    .map((candidate) => ({
      name: candidate.name,
      score: distance(candidate.name.toLowerCase(), key),
    }))
    .filter(
      (entry) =>
        entry.score <= Math.max(2, Math.floor(key.length / 3)) ||
        entry.name.toLowerCase().includes(key) ||
        (key.length > 2 && key.includes(entry.name.toLowerCase())),
    )
    .sort((a, b) => a.score - b.score)
    .slice(0, 3)
    .map((entry) => entry.name);
  return { close };
};

/** One bots_list line. */
export const listLine = (me: ProfileInfo, bot: ProfileInfo): string => {
  const role = roleOf(bot);
  const archived = bot.archivedAt !== null ? " [archived]" : "";
  const self = bot.id === me.id ? " (you)" : "";
  const contact =
    bot.id === me.id ? "" : `; you may message it: ${mayInitiate(me, bot) ? "yes" : "no"}`;
  return `- ${bot.name} (id: ${bot.id})${self}${archived}${role !== "" ? ` - ${role}` : ""}${contact}; tools: ${toolGroupsOf(bot)}`;
};

/** The bot_info card. `activity` is "busy (…)"/"idle" when known. */
export const infoText = (me: ProfileInfo, bot: ProfileInfo, activity: string | null): string => {
  const lines = [
    `${bot.name} (id: ${bot.id})${bot.id === me.id ? " - this is you" : ""}`,
    bot.archivedAt !== null ? "Status: archived (cannot send or receive)" : null,
    `Role: ${clip(bot.description, 500) || "(none given)"}`,
    personaFirstLine(bot) !== "" ? `Persona (first line): ${personaFirstLine(bot)}` : null,
    bot.id !== me.id
      ? `You may message it: ${mayInitiate(me, bot) ? "yes" : "no (your contact policy)"}`
      : null,
    bot.id !== me.id ? `It may message you first: ${mayInitiate(bot, me) ? "yes" : "no"}` : null,
    `Tool groups: ${toolGroupsOf(bot)}`,
    activity !== null ? `Activity: ${activity}` : null,
    bot.id !== me.id
      ? "Its memory, files, vault and chats are private to it; ask it, don't assume."
      : null,
  ];
  return lines.filter((line) => line !== null).join("\n");
};
