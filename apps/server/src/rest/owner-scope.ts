/**
 * Owner scoping: the ONE place REST decides whether the caller owns a bot, a
 * session or a routine record. Every check is `can()` applied to a resource;
 * a record the caller doesn't own is answered exactly like a record that
 * doesn't exist, so ids can't be probed across accounts.
 */
import type { RouteArgs } from "./types.ts";
import { can, type Action } from "./can.ts";

/** The actor every REST route acts as: the signed-in account. */
const actorOf = (args: RouteArgs): string => args.owner;

const ask = (args: RouteArgs, action: Action, owner: string, id: string): boolean =>
  can(actorOf(args), action, { type: "record", owner, id });

/** A bot (profile) id the caller owns: the row exists and can() confirms it. */
export const ownsProfile = async (args: RouteArgs, profileId: string): Promise<boolean> => {
  const row = await args.mind.profiles.get(args.owner, profileId);
  return (
    row !== undefined && can(actorOf(args), "view", { type: "bot", owner: row.owner, id: row.id })
  );
};

/** A chat session id the caller owns: the row exists and can() confirms it. */
export const ownsSession = async (args: RouteArgs, sessionId: string): Promise<boolean> => {
  const row = await args.mind.profiles.rowOf(sessionId);
  return (
    row !== undefined && can(actorOf(args), "view", { type: "chat", owner: row.owner, id: row.id })
  );
};

/**
 * Where a routine the caller creates should deliver: a session they own, or,
 * when the id names a bot they own, that bot's main chat (the app's pickers
 * list bots, not sessions). Anything else is undefined ("unknown session").
 */
export const ownedTarget = async (args: RouteArgs, id: string): Promise<string | undefined> => {
  if (await ownsSession(args, id)) return id;
  if (!(await ownsProfile(args, id))) return undefined;
  return (await args.mind.profiles.ensureMain(args.owner, id)).id;
};

/** The ids of every bot the caller owns. */
export const ownedProfileIds = async (args: RouteArgs): Promise<ReadonlySet<string>> =>
  new Set((await args.mind.profiles.list(args.owner)).map((profile) => profile.id));

/**
 * A routine record (cron job, webhook, sensor) stamped with the session it
 * delivers to and that session's bot. The session decides; when the session
 * row is gone, the bot does.
 */
export const ownsRecord = async (
  args: RouteArgs,
  record: { readonly sessionId: string; readonly profile: string },
): Promise<boolean> => {
  const row = await args.mind.profiles.rowOf(record.sessionId);
  return row !== undefined
    ? ask(args, "view", row.owner, record.sessionId)
    : ownsProfile(args, record.profile);
};

/** Keep only the records the caller owns, in order. */
export const ownedRecords = async <
  T extends { readonly sessionId: string; readonly profile: string },
>(
  args: RouteArgs,
  records: readonly T[],
): Promise<T[]> => {
  const keep = await Promise.all(records.map((record) => ownsRecord(args, record)));
  return records.filter((_, index) => keep[index] === true);
};

/** Find one record by id among the caller's own; another owner's reads as missing. */
export const findOwned = async <
  T extends { readonly id: string; readonly sessionId: string; readonly profile: string },
>(
  args: RouteArgs,
  records: readonly T[],
  id: string,
): Promise<T | undefined> => {
  const record = records.find((candidate) => candidate.id === id);
  return record !== undefined && (await ownsRecord(args, record)) ? record : undefined;
};
