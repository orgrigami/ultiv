/**
 * Owner takeover of a browser session: when a bot meets an identity wall (a
 * login, 2FA, a CAPTCHA — or a password field the tool refuses), it asks
 * with `browser_session` op "takeover"; the owner drives the page HERE, one
 * act at a time (each act returns the fresh screenshot — no stream, no
 * timer), and Finishing wakes the bot with the page as it stands. While a
 * takeover is OPEN, the registry refuses the bot's ACTS on that session
 * (refused, never queued): two drivers on one page is how pages break.
 */
export interface TakeoverInput {
  readonly conversationId: string;
  readonly reason: string;
  readonly shot: () => Promise<string>;
  /** One act: click/type/press/refresh on the session's channel. */
  readonly act: (act: TakeoverAct) => Promise<TakeoverState>;
  /** The page as it stands, for the bot's wake when the owner finishes. */
  readonly readPage: () => Promise<string>;
  /** The mind's wake: the bot's conversation hears this when the owner finishes. */
  readonly onFinished: (conversationId: string, wake: string) => void;
}

export type TakeoverAct =
  | { readonly kind: "click"; readonly selector: string }
  | { readonly kind: "type"; readonly selector: string; readonly text: string }
  | { readonly kind: "press"; readonly key: string }
  | { readonly kind: "refresh" };

export interface TakeoverState {
  readonly ok: boolean;
  readonly png: string;
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly error: string | null;
}

export interface TakeoverRow {
  readonly id: string;
  readonly conversationId: string;
  readonly reason: string;
  readonly openedAt: number;
}

export interface TakeoverRegistry {
  /** Register a bot's ask; only one OPEN takeover per conversation. */
  readonly open: (input: TakeoverInput) => Promise<TakeoverRow>;
  /** The owner's open takeovers (their bots' asks), newest first. */
  readonly list: () => readonly TakeoverRow[];
  readonly get: (id: string) => TakeoverRow | undefined;
  /** One owner act; returns the fresh view (the screenshot after the act). */
  readonly act: (id: string, act: TakeoverAct) => Promise<TakeoverState>;
  /** Finish: wake the bot with the page, close the takeover. */
  readonly finish: (id: string) => Promise<TakeoverRow | undefined>;
  /** Abort without waking the bot. */
  readonly cancel: (id: string) => Promise<TakeoverRow | undefined>;
  /** Whether the bot's own ACTS must be refused on this conversation now. */
  readonly holds: (conversationId: string) => boolean;
}

export const takeoverRegistry = (): TakeoverRegistry => {
  const open = new Map<string, TakeoverInput & { readonly row: TakeoverRow }>();
  let seq = 0;
  const rowOf = (id: string): TakeoverRow | undefined => open.get(id)?.row;
  return {
    open: async (input) => {
      for (const [id, held] of open) {
        if (held.row.conversationId === input.conversationId) {
          await held.shot().catch(() => "");
          open.delete(id);
        }
      }
      seq += 1;
      const row: TakeoverRow = {
        id: `takeover-${Date.now().toString(36)}-${seq}`,
        conversationId: input.conversationId,
        reason: input.reason.slice(0, 300),
        openedAt: Date.now(),
      };
      open.set(row.id, { ...input, row });
      await input.shot().catch(() => "");
      return row;
    },
    list: () =>
      [...open.values()].map((held) => held.row).toSorted((a, b) => b.openedAt - a.openedAt),
    get: (id) => rowOf(id),
    act: async (id, act) => {
      const held = open.get(id);
      if (held === undefined) throw new Error("that takeover is no longer open");
      return held.act(act);
    },
    finish: async (id) => {
      const held = open.get(id);
      if (held === undefined) return undefined;
      open.delete(id);
      const page = await held.readPage().catch(() => "the page could not be read");
      held.onFinished(
        held.row.conversationId,
        "[owner] the browser takeover is finished. The page as it stands:\n\n" + page,
      );
      return held.row;
    },
    cancel: async (id) => {
      const held = open.get(id);
      if (held === undefined) return undefined;
      open.delete(id);
      return held.row;
    },
    holds: (conversationId) =>
      [...open.values()].some((held) => held.row.conversationId === conversationId),
  };
};
