/**
 * The owner's Browsers panel: which of their bots have a browser session
 * going (one row per bot, named by the conversation holding it), where each
 * page stands and what it waits on, whether a takeover ask is open on it —
 * plus a WATCH-ONLY live view, the owner's Close, the bots' saved sign-ins
 * (Forget), signing a bot in yourself (an owner-started takeover on its
 * main chat's browser) and each bot's browsing history. Watching is the same cast the
 * takeover drives, but this route never accepts acts: the owner drives only
 * through a takeover (rest/takeover.ts), so the page moves under one pair of
 * hands at a time. Another owner's session, sign-ins or history answer
 * exactly like missing ones.
 */
import { Effect } from "effect";
import type { RouteArgs } from "./types.ts";
import { can } from "./can.ts";
import { ownsProfile } from "./owner-scope.ts";
import { botOf, holdsConversation, serveCast, viewSizeOf } from "./browser-cast.ts";

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
  popup: boolean;
  dialog: string | null;
  chooser: boolean;
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
        popup: session?.popup ?? false,
        dialog: session?.dialog ?? null,
        chooser: session?.chooser ?? false,
        ...(await botOf(args, conversationId)),
        takeoverId: ask?.id ?? null,
      };
    }),
  );
};

/** The caller's bot by id, or undefined (another owner's bot answers like a missing one). */
const ownBot = async (args: RouteArgs, profileId: string) => {
  if (!(await ownsProfile(args, profileId))) return undefined;
  const bot = await args.mind.profiles.get(args.owner, profileId).catch(() => undefined);
  return bot === undefined ? undefined : { profileId, botName: bot.name };
};

const CAST = /^\/api\/browser\/sessions\/([^/]+)\/cast$/;
const SIZE = /^\/api\/browser\/sessions\/([^/]+)\/cast\/size$/;
const SESSION = /^\/api\/browser\/sessions\/([^/]+)$/;
const SIGNINS = /^\/api\/browser\/signins\/([^/]+)$/;
const HISTORY = /^\/api\/browser\/history\/([^/]+)$/;
const SIGN_IN = /^\/api\/browser\/bots\/([^/]+)\/signin$/;

const httpUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length > 2_000) return undefined;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};

/** The owner signs a bot in: its main chat's browser, the owner at the controls. */
const signIn = async (args: RouteArgs, profileId: string): Promise<void> => {
  const { mind, json } = args;
  const bot = await ownBot(args, profileId);
  if (bot === undefined || mind.browserSignIn === undefined) {
    json(404, { error: "no such bot" });
    return;
  }
  const body = await args.readJson<{ url?: unknown } | null>(args.req);
  const url = httpUrl(body?.url);
  if (url === undefined) {
    json(400, { error: "send { url } — the sign-in page's address" });
    return;
  }
  const session = await mind.profiles.ensureMain(args.owner, profileId);
  const key = await mind.profiles.keyOfRow(session);
  const conversationId = String(await Effect.runPromise(mind.converse.conversationIdOf(key)));
  const started = await mind.browserSignIn(conversationId, url, bot.botName);
  json(started.ok ? 200 : 409, started);
};

const castRoutes = async (args: RouteArgs, method: string): Promise<boolean> => {
  const { mind, path, json } = args;
  const cast = path.match(CAST);
  if (cast !== null && method === "GET") {
    const conversationId = decodeURIComponent(cast[1] ?? "");
    const live = (): boolean =>
      mind.browserSessions?.get(conversationId) !== undefined &&
      mind.browserTakeovers?.holds(conversationId) !== true;
    if (!sees(args, conversationId) || !live()) {
      json(404, { error: "that browser is not open" });
      return true;
    }
    const view = viewSizeOf(args.url.searchParams.get("w"), args.url.searchParams.get("h"));
    await serveCast(args, conversationId, live, view ?? {});
    return true;
  }
  const size = path.match(SIZE);
  if (size !== null && method === "POST") {
    const conversationId = decodeURIComponent(size[1] ?? "");
    const body = await args.readJson<{ w?: unknown; h?: unknown } | null>(args.req);
    const view = viewSizeOf(body?.w, body?.h);
    if (!sees(args, conversationId) || view === undefined) {
      json(view === undefined ? 400 : 404, {
        error: view === undefined ? "send { w, h }" : "that browser is not open",
      });
      return true;
    }
    await mind.browserCasts?.size(conversationId, view.w, view.h);
    json(200, { ok: true });
    return true;
  }
  return false;
};

const signinRoutes = async (args: RouteArgs, method: string): Promise<boolean> => {
  const { mind, path, json } = args;
  if (path === "/api/browser/signins" && method === "GET") {
    const rows = mind.browserSignins?.list(args.owner) ?? [];
    const named = await Promise.all(
      rows.map(async (row) => {
        const bot = await ownBot(args, row.profile);
        return bot === undefined ? undefined : { ...bot, sites: row.sites, savedAt: row.savedAt };
      }),
    );
    json(200, {
      signins: named.filter((row) => row !== undefined),
      available: mind.browserSignins !== undefined,
    });
    return true;
  }
  const signins = path.match(SIGNINS);
  if (signins !== null && method === "DELETE") {
    const profileId = decodeURIComponent(signins[1] ?? "");
    if ((await ownBot(args, profileId)) === undefined || mind.browserLife === undefined) {
      json(404, { error: "no such bot" });
      return true;
    }
    json(200, { ok: true, forgot: await mind.browserLife.forget(args.owner, profileId) });
    return true;
  }
  const signInMatch = path.match(SIGN_IN);
  if (signInMatch !== null && method === "POST") {
    await signIn(args, decodeURIComponent(signInMatch[1] ?? ""));
    return true;
  }
  const history = path.match(HISTORY);
  if (history !== null && method === "GET") {
    const profileId = decodeURIComponent(history[1] ?? "");
    const bot = await ownBot(args, profileId);
    json(200, {
      history: bot === undefined ? [] : (mind.browserLife?.history(args.owner, profileId) ?? []),
    });
    return true;
  }
  return false;
};

export async function browserSessionRoutes(args: RouteArgs): Promise<boolean> {
  const { mind, path, json } = args;
  const method = args.req.method ?? "GET";
  if (path === "/api/browser/sessions" && method === "GET") {
    json(200, { sessions: await sessionsFor(args) });
    return true;
  }
  const session = path.match(SESSION);
  if (session !== null && method === "DELETE") {
    // The owner's Close: whoever holds it, the session ends (sign-ins saved).
    const conversationId = decodeURIComponent(session[1] ?? "");
    if (!holdsConversation(args, conversationId) || mind.browserLife === undefined) {
      json(404, { error: "that browser is not open" });
      return true;
    }
    const ask = mind.browserTakeovers?.forConversation(conversationId);
    if (ask !== undefined) await mind.browserTakeovers?.cancel(ask.id);
    json(200, {
      ok: true,
      closed: await mind.browserLife.close(conversationId, "your owner closed it", true),
    });
    return true;
  }
  return (await castRoutes(args, method)) || (await signinRoutes(args, method));
}
