/**
 * The owner's Browsers panel: which of their bots have a browser session
 * going, where each page stands, and whether a takeover ask is waiting on
 * it — plus a WATCH-ONLY live view of any of them. Watching is the same
 * cast the takeover drives, but this route never accepts acts: the owner
 * drives only through a takeover (rest/takeover.ts), so the page moves
 * under one pair of hands at a time. Another owner's session is invisible,
 * exactly like a missing one.
 */
import type { RouteArgs } from "./types.ts";
import { can } from "./can.ts";
import { botOf, serveCast } from "./browser-cast.ts";

const sees = (args: RouteArgs, conversationId: string): boolean => {
  const scope = args.mind.profiles.scopeOf(conversationId);
  return (
    scope !== undefined &&
    can(args.owner, "view", { type: "chat", owner: scope.owner, id: conversationId })
  );
};

/** A session row as the panel shows it. */
export interface BrowserSessionView {
  conversationId: string;
  url: string;
  title: string;
  at: number;
  profileId: string | null;
  botName: string;
  /** The open takeover ask on this session, if one waits on the owner. */
  takeoverId: string | null;
}

/** The caller's sessions, newest activity first; an open ask lists even before its first page. */
const sessionsFor = async (args: RouteArgs): Promise<BrowserSessionView[]> => {
  const sessions = args.mind.browserSessions?.list() ?? [];
  const takeovers = args.mind.browserTakeovers?.list() ?? [];
  const ids = [
    ...new Set([
      ...takeovers.map((row) => row.conversationId),
      ...sessions.map((row) => row.conversationId),
    ]),
  ].filter((id) => sees(args, id));
  return Promise.all(
    ids.map(async (conversationId) => {
      const session = sessions.find((row) => row.conversationId === conversationId);
      const ask = takeovers.find((row) => row.conversationId === conversationId);
      return {
        conversationId,
        url: session?.url ?? "",
        title: session?.title ?? "",
        at: session?.at ?? ask?.openedAt ?? 0,
        ...(await botOf(args, conversationId)),
        takeoverId: ask?.id ?? null,
      };
    }),
  );
};

const CAST = /^\/api\/browser\/sessions\/([^/]+)\/cast$/;

export async function browserSessionRoutes(args: RouteArgs): Promise<boolean> {
  const { mind, path, json } = args;
  const method = args.req.method ?? "GET";
  if (path === "/api/browser/sessions" && method === "GET") {
    json(200, { sessions: await sessionsFor(args) });
    return true;
  }
  const cast = path.match(CAST);
  if (cast !== null && method === "GET") {
    const conversationId = decodeURIComponent(cast[1] ?? "");
    const live = (): boolean =>
      mind.browserSessions?.get(conversationId) !== undefined ||
      mind.browserTakeovers?.holds(conversationId) === true;
    if (!sees(args, conversationId) || !live()) {
      json(404, { error: "that browser is not open" });
      return true;
    }
    await serveCast(args, conversationId, live);
    return true;
  }
  return false;
}
