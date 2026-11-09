/**
 * Which bots have a browser session going, which conversation holds each,
 * and where its page stands — what the owner's Browsers panel lists, one
 * row per BOT (a bot has at most one session, held by one conversation at a
 * time). A row lives from the session's first successful op until it closes
 * (the holder's `close`, its task ending, the idle window, the owner's
 * Close, or the browser going away). Facts only (url, title, what the page
 * waits on, when): never page text, never a screenshot. In memory: a server
 * restart forgets it, and the broker's own idle backstop closes what the
 * server forgot.
 */
export interface ActiveBrowser {
  /** The broker's key for the bot's session (its Linux user in the VM). */
  readonly bot: string;
  /** The conversation holding the session. */
  readonly conversationId: string;
  readonly url: string;
  readonly title: string;
  /** When the bot (or the owner, driving) last acted on it (ms). */
  readonly at: number;
  /** The page on show is a popup the main tab opened. */
  readonly popup: boolean;
  /** An open alert/confirm/prompt's message: the page waits on an answer. */
  readonly dialog: string | null;
  /** The page asked for a file. */
  readonly chooser: boolean;
}

export type BrowserFacts = Partial<
  Pick<ActiveBrowser, "url" | "title" | "popup" | "dialog" | "chooser">
>;

export interface ActiveBrowsers {
  /** Newest activity first. */
  readonly list: () => readonly ActiveBrowser[];
  /** The session a conversation holds, if any. */
  readonly get: (conversationId: string) => ActiveBrowser | undefined;
  readonly ofBot: (bot: string) => ActiveBrowser | undefined;
  /** A successful op: the session is held by this conversation and stands here. */
  readonly touch: (bot: string, conversationId: string, facts: BrowserFacts) => void;
  /** The session ended. */
  readonly drop: (bot: string) => void;
  /** A session appeared, moved, changed what it waits on, or ended. Returns the unsubscribe. */
  readonly listen: (listener: () => void) => () => void;
}

const SHOWN: readonly (keyof BrowserFacts)[] = ["url", "title", "popup", "dialog", "chooser"];

export const activeBrowsers = (): ActiveBrowsers => {
  const rows = new Map<string, ActiveBrowser>();
  const listeners = new Set<() => void>();
  const tell = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A listener's failure never breaks the bot's call.
      }
    }
  };
  return {
    list: () => [...rows.values()].toSorted((a, b) => b.at - a.at),
    get: (conversationId) =>
      [...rows.values()].find((row) => row.conversationId === conversationId),
    ofBot: (bot) => rows.get(bot),
    touch: (bot, conversationId, facts) => {
      const before = rows.get(bot);
      const next: ActiveBrowser = {
        bot,
        conversationId,
        url: (facts.url ?? before?.url ?? "").slice(0, 2_000),
        title: (facts.title ?? before?.title ?? "").slice(0, 300),
        at: Date.now(),
        popup: facts.popup ?? before?.popup ?? false,
        dialog: facts.dialog === undefined ? (before?.dialog ?? null) : facts.dialog,
        chooser: facts.chooser ?? before?.chooser ?? false,
      };
      rows.set(bot, next);
      // Signal only what the list shows: a new session, a new holder, a new page.
      const moved =
        before === undefined ||
        before.conversationId !== conversationId ||
        SHOWN.some((key) => before[key] !== next[key]);
      if (moved) tell();
    },
    drop: (bot) => {
      if (rows.delete(bot)) tell();
    },
    listen: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
