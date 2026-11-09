/**
 * A bot's browser session over its whole life, on the server's side: the
 * broker call (one session per bot, held by one conversation), the row the
 * owner's panel lists, the idle window, the end, and the sign-ins kept
 * across sessions.
 *
 * - Opening a bot's FIRST session restores its saved sign-ins (cookies and
 *   the user agent they were made under) before the first page loads.
 * - A session ends on the holder's `close`, its task ending (`release`),
 *   IDLE_MS without an act (an open takeover keeps it awake), the owner's
 *   Close, or the browser going away. Every end saves the cookies of the
 *   sites the bot signed in to, then closes the context in the broker.
 * - Each bot keeps a short history (pages, sign-ins, takeovers, files) the
 *   panel shows: what its browser did, in the owner's words.
 */
import type { BrowserSeat } from "./backends.ts";
import type { BrokerClient, BrokerReply } from "./broker-client.ts";
import type { ActiveBrowsers } from "./active.ts";
import { siteOf, type SigninStore } from "./signins.ts";

/** A session idle this long closes (and saves its sign-ins). */
export const IDLE_MS = 10 * 60_000;
const HISTORY_KEPT = 60;

export type HistoryKind =
  | "page"
  | "signin"
  | "restore"
  | "forget"
  | "takeover"
  | "download"
  | "upload"
  | "close";

export interface HistoryEntry {
  readonly at: number;
  readonly kind: HistoryKind;
  readonly text: string;
}

type Scope = { readonly owner: string; readonly profile: string };

export interface BrowserLifeDeps {
  readonly resolveOf: (conversationId: string) => Promise<BrowserSeat>;
  readonly client: BrokerClient;
  readonly browsers: ActiveBrowsers;
  /** An open takeover on this conversation: the session must not idle out. */
  readonly held: (conversationId: string) => boolean;
  /** The session ended: stop its live views. */
  readonly onEnded: (conversationId: string) => void;
  readonly scopeOf?: (conversationId: string) => Scope | undefined;
  readonly signins?: SigninStore | undefined;
  readonly idleMs?: number;
}

export interface BrowserLife {
  /** One broker op for a conversation's session (restoring sign-ins on a first open). */
  readonly run: (
    conversationId: string,
    request: Readonly<Record<string, unknown>>,
    options?: { readonly viaStdin?: boolean; readonly timeoutMs?: number },
  ) => Promise<BrokerReply>;
  /** The bot signed in on this host (a takeover finished, a vault login filled). */
  readonly signedIn: (conversationId: string, host: string, how: string) => void;
  readonly note: (conversationId: string, kind: HistoryKind, text: string) => void;
  /** End the session a conversation holds (or, `force`, the bot's session whoever holds it). */
  readonly close: (conversationId: string, reason: string, force?: boolean) => Promise<boolean>;
  /** A conversation is over (its task ended): close the session it holds. */
  readonly release: (conversationId: string) => void;
  readonly forget: (owner: string, profile: string) => Promise<boolean>;
  readonly history: (owner: string, profile: string) => readonly HistoryEntry[];
  readonly hold: (conversationId: string, on: boolean) => Promise<void>;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

type Summary = {
  readonly url?: string;
  readonly title?: string;
  readonly popup?: boolean;
  readonly dialog?: { readonly message?: string };
  readonly chooser?: unknown;
};

export const browserLife = (deps: BrowserLifeDeps): BrowserLife => {
  const idleMs = deps.idleMs ?? IDLE_MS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const sites = new Map<string, Set<string>>();
  const histories = new Map<string, HistoryEntry[]>();

  const keyOf = (conversationId: string, bot: string): string => {
    const scope = deps.scopeOf?.(conversationId);
    return scope === undefined ? `bot:${bot}` : `${scope.owner}/${scope.profile}`;
  };

  const record = (key: string, kind: HistoryKind, text: string): void => {
    const rows = histories.get(key) ?? [];
    rows.push({ at: Date.now(), kind, text: text.slice(0, 300) });
    histories.set(key, rows.slice(-HISTORY_KEPT));
  };

  const arm = (bot: string, conversationId: string): void => {
    const before = timers.get(bot);
    if (before !== undefined) clearTimeout(before);
    const timer = setTimeout(() => {
      timers.delete(bot);
      const row = deps.browsers.ofBot(bot);
      if (row === undefined) return;
      if (deps.held(row.conversationId)) arm(bot, row.conversationId);
      else void closeBot(bot, row.conversationId, "idle for 10 minutes", true);
    }, idleMs);
    timer.unref?.();
    timers.set(bot, timer);
    void conversationId;
  };

  const save = async (seat: BrowserSeat, bot: string, conversationId: string): Promise<void> => {
    const scope = deps.scopeOf?.(conversationId);
    const known = sites.get(bot);
    if (
      deps.signins === undefined ||
      scope === undefined ||
      known === undefined ||
      known.size === 0
    )
      return;
    const reply = await deps.client.call(seat.backend, {
      op: "cookies_export",
      bot,
      force: true,
      domains: [...known],
    });
    if (reply.ok !== true || !Array.isArray(reply.cookies)) return;
    deps.signins.save(scope.owner, scope.profile, {
      sites: [...known],
      ua: typeof reply.ua === "string" ? reply.ua : "",
      cookies: reply.cookies as Record<string, unknown>[],
    });
  };

  const closeBot = async (
    bot: string,
    conversationId: string,
    reason: string,
    force: boolean,
  ): Promise<boolean> => {
    const seat = await deps.resolveOf(conversationId);
    await save(seat, bot, conversationId).catch(() => undefined);
    const reply = await deps.client.call(seat.backend, {
      op: "close",
      bot,
      conv: conversationId,
      force,
    });
    if (reply.ok !== true && reply.kind === "busy") return false;
    const timer = timers.get(bot);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(bot);
    sites.delete(bot);
    deps.browsers.drop(bot);
    deps.onEnded(conversationId);
    record(keyOf(conversationId, bot), "close", `closed the browser (${reason})`);
    return true;
  };

  const restore = async (
    seat: BrowserSeat,
    bot: string,
    conversationId: string,
  ): Promise<string | undefined> => {
    const scope = deps.scopeOf?.(conversationId);
    if (deps.signins === undefined || scope === undefined) return undefined;
    const saved = deps.signins.load(scope.owner, scope.profile);
    if (saved === undefined || saved.cookies.length === 0) return undefined;
    const reply = await deps.client.call(
      seat.backend,
      { op: "cookies_import", bot, conv: conversationId, cookies: saved.cookies, ua: saved.ua },
      { viaStdin: true },
    );
    if (reply.ok !== true) return undefined;
    sites.set(bot, new Set(saved.sites));
    record(
      keyOf(conversationId, bot),
      "restore",
      `restored saved sign-ins: ${saved.sites.join(", ")}`,
    );
    return saved.ua;
  };

  const run: BrowserLife["run"] = async (conversationId, request, options = {}) => {
    const seat = await deps.resolveOf(conversationId);
    const bot = seat.bot;
    if (bot === undefined) {
      return {
        ok: false,
        kind: "no-users",
        error: "this home has no per-bot users yet, so its bots cannot browse",
      };
    }
    const fresh = deps.browsers.ofBot(bot) === undefined;
    const ua =
      fresh && request.op === "open" ? await restore(seat, bot, conversationId) : undefined;
    const reply = await deps.client.call(
      seat.backend,
      {
        ...request,
        bot,
        conv: conversationId,
        idle_s: Math.round(idleMs / 1000),
        ...(ua !== undefined && ua !== "" ? { ua } : {}),
      },
      options,
    );
    if (reply.kind === "browser-down" || reply.kind === "no-session") {
      timers.delete(bot);
      deps.browsers.drop(bot);
    }
    const summary = reply.session as Summary | null | undefined;
    if (reply.ok === true && summary !== undefined && summary !== null) {
      deps.browsers.touch(bot, conversationId, {
        url: summary.url ?? "",
        title: summary.title ?? "",
        popup: summary.popup === true,
        dialog: summary.dialog?.message ?? null,
        chooser: summary.chooser !== undefined,
      });
      arm(bot, conversationId);
      if (request.op === "open" && typeof reply.url === "string") {
        record(keyOf(conversationId, bot), "page", `opened ${hostOf(reply.url) || reply.url}`);
      }
    }
    return reply;
  };

  return {
    run,
    signedIn: (conversationId, host, how) => {
      const row = deps.browsers.get(conversationId);
      if (row === undefined || host === "") return;
      const known = sites.get(row.bot) ?? new Set<string>();
      known.add(siteOf(host));
      sites.set(row.bot, known);
      record(keyOf(conversationId, row.bot), "signin", `signed in on ${host} (${how})`);
    },
    note: (conversationId, kind, text) => {
      const row = deps.browsers.get(conversationId);
      record(keyOf(conversationId, row?.bot ?? "default"), kind, text);
    },
    close: async (conversationId, reason, force = false) => {
      const row = deps.browsers.get(conversationId);
      if (row !== undefined) return closeBot(row.bot, conversationId, reason, force);
      // Not listed (a server restart forgot it): close the bot's session in the broker anyway.
      const seat = await deps.resolveOf(conversationId);
      if (seat.bot === undefined) return false;
      const reply = await deps.client.call(seat.backend, {
        op: "close",
        bot: seat.bot,
        conv: conversationId,
        force,
      });
      return reply.ok === true && reply.closed === true;
    },
    release: (conversationId) => {
      const row = deps.browsers.get(conversationId);
      if (row !== undefined)
        void closeBot(row.bot, conversationId, "its task ended", false).catch(() => undefined);
    },
    forget: async (owner, profile) => {
      const forgot = deps.signins?.forget(owner, profile) ?? false;
      for (const row of deps.browsers.list()) {
        const scope = deps.scopeOf?.(row.conversationId);
        if (scope?.owner !== owner || scope.profile !== profile) continue;
        sites.delete(row.bot);
        const seat = await deps.resolveOf(row.conversationId);
        await deps.client
          .call(seat.backend, { op: "cookies_clear", bot: row.bot })
          .catch(() => undefined);
      }
      record(`${owner}/${profile}`, "forget", "forgot every saved sign-in");
      return forgot;
    },
    history: (owner, profile) => histories.get(`${owner}/${profile}`) ?? [],
    hold: async (conversationId, on) => {
      const row = deps.browsers.get(conversationId);
      if (row === undefined) return;
      const seat = await deps.resolveOf(conversationId);
      await deps.client.call(seat.backend, { op: "hold", bot: row.bot, on }).catch(() => undefined);
      if (!on) arm(row.bot, conversationId);
    },
  };
};
