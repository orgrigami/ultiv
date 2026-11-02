/**
 * Owner scoping: the ONE place REST decides whether the caller owns a bot, a
 * session or a routine record. Every check is `can()` applied to a resource;
 * a record the caller doesn't own is answered exactly like a record that
 * doesn't exist, so ids can't be probed across accounts or roles.
 */
import { homeOf } from "@spriessen/mind";
import type { RouteArgs } from "./types.ts";
import { can, type Action, type OrgView } from "./can.ts";

/** The actor every REST route acts as: the signed-in account. */
const actorOf = (args: RouteArgs): string => args.owner;

/** The org view a role-aware decision needs (empty on a fresh install). */
const viewOf = async (args: RouteArgs): Promise<OrgView | undefined> => {
  const view = await args.mind.org.view();
  return view;
};

const ask = async (args: RouteArgs, action: Action, owner: string, id: string): Promise<boolean> =>
  can(actorOf(args), action, { type: "record", owner, id }, await viewOf(args));

/** A bot (profile) id the caller may reach: the row exists and can() confirms it. */
export const ownsProfile = async (args: RouteArgs, profileId: string): Promise<boolean> => {
  const [row, view] = await Promise.all([
    args.mind.profiles.get(args.owner, profileId),
    viewOf(args),
  ]);
  if (row === undefined) return false;
  return can(
    actorOf(args),
    "view",
    { type: "bot", owner: row.owner, id: row.id, home: homeOf(row) },
    view,
  );
};

/** A chat session id the caller owns: the row exists and can() confirms it. */
export const ownsSession = async (args: RouteArgs, sessionId: string): Promise<boolean> => {
  const [row, view] = await Promise.all([args.mind.profiles.rowOf(sessionId), viewOf(args)]);
  return (
    row !== undefined &&
    can(actorOf(args), "view", { type: "chat", owner: row.owner, id: row.id }, view)
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

// -- Owner-level records (nodes): a guest is nobody, another owner's row reads as missing. --

const ownsOwnerRow = (args: RouteArgs, rowOwner: string): boolean =>
  args.owner !== "" && args.owner !== "guest" && rowOwner === args.owner;

/** Keep only the caller's own nodes, in order. */
export const nodesOwned = async <T extends { readonly owner: string }>(
  args: RouteArgs,
  records: readonly T[],
): Promise<T[]> => records.filter((record) => ownsOwnerRow(args, record.owner));

/** One node by id among the caller's own; another owner's reads as missing. */
export const findOwnedNode = async <T extends { readonly owner: string }>(
  args: RouteArgs,
  record: T | undefined,
): Promise<T | undefined> =>
  record !== undefined && ownsOwnerRow(args, record.owner) ? record : undefined;

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
    ? await ask(args, "view", row.owner, record.sessionId)
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
