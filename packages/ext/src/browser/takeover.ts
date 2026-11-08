/**
 * Owner takeover of a browser session: when a bot meets an identity wall (a
 * login, 2FA, a CAPTCHA — or a password field the tool refuses), it asks
 * with `browser_session` op "takeover" and the call WAITS — the owner
 * drives the page live (the cast) and the tool result returns the page as
 * it stands when they Finish. The wait resolves on every close: finish,
 * step-away, the cap (30 min — an abandoned ask never pins a turn, or a
 * hold, forever), or a newer ask replacing the row. While a takeover is
 * OPEN the registry refuses the bot's ACTS on that session (refused, never
 * queued): two drivers on one page is how pages break. There is no wake to
 * route: the turn that asked is the turn that gets the answer.
 */
export interface TakeoverInput {
  readonly conversationId: string;
  readonly reason: string;
  /** One selector act (the legacy REST path; the live cast is the seat now). */
  readonly act: (act: TakeoverAct) => Promise<TakeoverState>;
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

/** How a takeover closed — what the waiting tool call tells the bot. */
export type TakeoverOutcome = "finished" | "stepped-away" | "timed-out" | "replaced";

/** A takeover's hard life span: an owner who walked away cannot hold the bot forever. */
export const TAKEOVER_MAX_MS = 30 * 60_000;

export interface TakeoverRegistry {
  /** Register a bot's ask; only one OPEN takeover per conversation. */
  readonly open: (input: TakeoverInput) => Promise<TakeoverRow>;
  /** The owner's open takeovers (their bots' asks), newest first. */
  readonly list: () => readonly TakeoverRow[];
  readonly get: (id: string) => TakeoverRow | undefined;
  /** One owner act on the legacy selector path; returns the fresh view. */
  readonly act: (id: string, act: TakeoverAct) => Promise<TakeoverState>;
  /** Finish: close the ask as done — the waiting call gets the page. */
  readonly finish: (id: string) => Promise<TakeoverRow | undefined>;
  /** Abort without a page: the waiting call learns the owner stepped away. */
  readonly cancel: (id: string) => Promise<TakeoverRow | undefined>;
  /** Resolve when this ask closes, with how. The bot's tool call waits here. */
  readonly wait: (id: string) => Promise<TakeoverOutcome>;
  /** Whether the bot's own ACTS must be refused on this conversation now. */
  readonly holds: (conversationId: string) => boolean;
}

export interface TakeoverRegistryOptions {
  /** The cap after which an open ask closes itself (tests shrink it). */
  readonly maxMs?: number;
  /** Called when ANY ask closes (finish, step-away, cap, replacement). */
  readonly onClosed?: (conversationId: string) => void;
}

interface Held {
  readonly input: TakeoverInput;
  readonly row: TakeoverRow;
  readonly waiters: ((outcome: TakeoverOutcome) => void)[];
  cap: ReturnType<typeof setTimeout> | null;
}

export const takeoverRegistry = (options: TakeoverRegistryOptions = {}): TakeoverRegistry => {
  const maxMs = options.maxMs ?? TAKEOVER_MAX_MS;
  const open = new Map<string, Held>();
  let seq = 0;

  const settle = (held: Held, outcome: TakeoverOutcome): void => {
    if (!open.has(held.row.id)) return;
    open.delete(held.row.id);
    if (held.cap !== null) clearTimeout(held.cap);
    for (const waiter of held.waiters) waiter(outcome);
    options.onClosed?.(held.row.conversationId);
  };

  const heldOf = (conversationId: string): Held | undefined =>
    [...open.values()].find((held) => held.row.conversationId === conversationId);

  return {
    open: async (input) => {
      const existing = heldOf(input.conversationId);
      if (existing !== undefined) settle(existing, "replaced");
      seq += 1;
      const row: TakeoverRow = {
        id: `takeover-${Date.now().toString(36)}-${seq}`,
        conversationId: input.conversationId,
        reason: input.reason.slice(0, 300),
        openedAt: Date.now(),
      };
      const held: Held = { input, row, waiters: [], cap: null };
      open.set(row.id, held);
      held.cap = setTimeout(() => settle(held, "timed-out"), maxMs);
      held.cap.unref?.();
      return row;
    },
    list: () =>
      [...open.values()].map((held) => held.row).toSorted((a, b) => b.openedAt - a.openedAt),
    get: (id) => open.get(id)?.row,
    act: async (id, act) => {
      const held = open.get(id);
      if (held === undefined) throw new Error("that takeover is no longer open");
      return held.input.act(act);
    },
    finish: async (id) => {
      const held = open.get(id);
      if (held === undefined) return undefined;
      settle(held, "finished");
      return held.row;
    },
    cancel: async (id) => {
      const held = open.get(id);
      if (held === undefined) return undefined;
      settle(held, "stepped-away");
      return held.row;
    },
    wait: (id) =>
      new Promise<TakeoverOutcome>((resolve) => {
        const held = open.get(id);
        // A row that is already gone closes without a page: the ask was
        // settled (or replaced) between open and wait.
        if (held === undefined) {
          resolve("stepped-away");
          return;
        }
        held.waiters.push(resolve);
      }),
    holds: (conversationId) => heldOf(conversationId) !== undefined,
  };
};
