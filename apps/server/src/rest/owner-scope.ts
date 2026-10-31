/**
 * Owner scoping: the ONE place REST decides whether the caller owns a bot, a
 * session or a routine record. Every owner-data route asks here, and a record
 * the caller doesn't own is answered exactly like a record that doesn't exist,
 * so ids can't be probed across owners.
 *
 * The caller's owner label comes from `args.owner` (identity.ts: the
 * `x-spreissen-user` header, `x-ultiv-user` as fallback, "guest" without one).
 * A real sign-in later swaps that source; these checks stay as they are.
 */
import type { RouteArgs } from "./types.ts";

/** A bot (profile) id the caller owns. */
export const ownsProfile = async (args: RouteArgs, profileId: string): Promise<boolean> =>
  (await args.mind.profiles.get(args.owner, profileId)) !== undefined;

/** A chat session id the caller owns. */
export const ownsSession = async (args: RouteArgs, sessionId: string): Promise<boolean> =>
  (await args.mind.profiles.rowOf(sessionId))?.owner === args.owner;

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
  return row !== undefined ? row.owner === args.owner : ownsProfile(args, record.profile);
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
