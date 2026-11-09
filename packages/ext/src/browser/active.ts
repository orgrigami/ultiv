/**
 * Which conversations have a browser session going, and where its page
 * stands — what the owner's Browsers panel lists. A session counts from its
 * first successful op until `close` (or a failed op that found the browser
 * gone). Facts only (url, title, when): never page text, never a screenshot.
 * In memory, like the takeover registry: a server restart forgets it, and
 * the next op the bot runs lists it again.
 */
export interface ActiveBrowser {
  readonly conversationId: string;
  readonly url: string;
  readonly title: string;
  /** When the bot last ran an op on it (ms). */
  readonly at: number;
}

export interface ActiveBrowsers {
  /** Newest activity first. */
  readonly list: () => readonly ActiveBrowser[];
  readonly get: (conversationId: string) => ActiveBrowser | undefined;
  /** A successful op: the page now stands here. */
  readonly touch: (
    conversationId: string,
    url: string | undefined,
    title: string | undefined,
  ) => void;
  /** The session ended (`close`, or the browser is gone). */
  readonly drop: (conversationId: string) => void;
  /** A session appeared, moved to another page, or ended. Returns the unsubscribe. */
  readonly listen: (listener: () => void) => () => void;
}

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
    get: (conversationId) => rows.get(conversationId),
    touch: (conversationId, url, title) => {
      const before = rows.get(conversationId);
      const next: ActiveBrowser = {
        conversationId,
        url: (url ?? before?.url ?? "").slice(0, 2_000),
        title: (title ?? before?.title ?? "").slice(0, 300),
        at: Date.now(),
      };
      rows.set(conversationId, next);
      // Signal only what the list shows: a new session or a new page.
      if (before === undefined || before.url !== next.url || before.title !== next.title) tell();
    },
    drop: (conversationId) => {
      if (rows.delete(conversationId)) tell();
    },
    listen: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
