/**
 * The owner's LIVE cast over a bot's browser: one broker cast per
 * conversation (browser/vm/cast.py through the VM's root relay), its frames
 * fanned out to every viewer and the owner's input acts written to its
 * stdin. A DRIVE cast (an open takeover) takes acts and pins the viewport;
 * a WATCH cast only streams, and is replaced the moment a takeover opens on
 * the same session (two screencasts on one page fight). Frame size follows
 * the largest viewer (`size`). A download the page finishes is taken off
 * the broker and saved to the bot's files; viewers hear `saved`. When the
 * last viewer leaves, the cast winds down after a grace (a tab switch does
 * not restart it), and it dies outright at the stream's timeout. Nothing
 * here polls: frames are push, acts are calls.
 */
import type { ShellStream } from "../shell/backend.ts";
import type { BrowserSeat } from "./backends.ts";
import type { BrokerClient } from "./broker-client.ts";
import { readCastLine, type CastAct, type CastEvent, type CastFrame } from "./cast-events.ts";

export type { CastAct, CastEvent, CastFrame } from "./cast-events.ts";

/** One cast may outlive a long takeover, but not the afternoon. */
export const CAST_TIMEOUT_MS = 2 * 60 * 60_000;

export interface CastSession {
  readonly conversationId: string;
  readonly drive: boolean;
  /** The newest frame the cast produced (a late viewer paints instantly). */
  readonly frame: CastFrame | null;
  /** Subscribe from now on; the CURRENT frame (if any) is delivered first. */
  readonly subscribe: (listener: (event: CastEvent) => void) => () => void;
  /** One owner act; resolves once written, rejects when the cast is dead. */
  readonly act: (input: CastAct) => Promise<void>;
  /** A viewer left; the cast winds down once the last one has. */
  readonly release: () => void;
}

export interface CastOptions {
  /** A takeover's driving seat (acts accepted); default watch-only. */
  readonly drive?: boolean;
  /** The viewer's frame size in device pixels (the cast sends no larger). */
  readonly w?: number;
  readonly h?: number;
}

export interface CastSessions {
  /** Start (or attach to) a conversation's cast and count one viewer. */
  readonly for: (conversationId: string, options?: CastOptions) => Promise<CastSession>;
  /** One act on a LIVE drive cast, without counting a viewer (the act routes). */
  readonly act: (conversationId: string, act: CastAct) => Promise<void>;
  /** A viewer's display size changed (full screen): frames follow it. */
  readonly size: (conversationId: string, w: number, h: number) => Promise<void>;
  /** End a conversation's cast now (a finished takeover, a closed session). */
  readonly stop: (conversationId: string, reason?: string) => Promise<void>;
}

export interface CastDeps {
  /** The home VM's seat for the conversation (browser/backends.ts). */
  readonly resolveOf: (conversationId: string) => Promise<BrowserSeat>;
  readonly client: BrokerClient;
  /** Store a finished download in the bot's files; its artifact id and name. */
  readonly saveDownload?: (
    conversationId: string,
    name: string,
    bytes: Uint8Array,
  ) => Promise<{ readonly id: string; readonly name: string } | undefined>;
  /** How long a cast with no viewers lingers before it stops. */
  readonly idleMs?: number;
}

interface Held {
  readonly conversationId: string;
  readonly drive: boolean;
  readonly stream: ShellStream;
  readonly listeners: Set<(event: CastEvent) => void>;
  readonly sizes: Map<number, { w: number; h: number }>;
  frame: CastFrame | null;
  reason: string;
  dead: boolean;
  viewers: number;
  idle: ReturnType<typeof setTimeout> | null;
}

const clampSize = (
  value: number | undefined,
  low: number,
  high: number,
  fallback: number,
): number =>
  value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(low, Math.min(high, Math.round(value)));

export const castSessions = (deps: CastDeps): CastSessions => {
  const idleMs = deps.idleMs ?? 8_000;
  const live = new Map<string, Held>();
  // A start in flight: a second viewer arriving while the cast launches
  // joins it instead of launching a second cast on the same page.
  const starting = new Map<string, Promise<Held>>();
  let viewerSeq = 0;

  const teardown = (held: Held): void => {
    if (held.dead) return;
    held.dead = true;
    if (held.idle !== null) clearTimeout(held.idle);
    if (live.get(held.conversationId) === held) live.delete(held.conversationId);
    void held.stream.write('{"a":"stop"}\n').catch(() => undefined);
    void held.stream.stop().catch(() => undefined);
    for (const listener of held.listeners) {
      listener({ kind: "closed", reason: held.reason === "" ? "the cast ended" : held.reason });
    }
  };

  const emit = (held: Held, event: CastEvent): void => {
    for (const listener of held.listeners) listener(event);
  };

  const save = async (held: Held, name: string, data: string): Promise<void> => {
    const bytes = new Uint8Array(Buffer.from(data, "base64"));
    const saved = await deps
      .saveDownload?.(held.conversationId, name, bytes)
      .catch(() => undefined);
    if (saved !== undefined) emit(held, { kind: "saved", id: saved.id, name: saved.name });
    else emit(held, { kind: "error", error: `the download "${name}" could not be saved` });
  };

  const onLine = (held: Held, line: string): void => {
    const read = readCastLine(line);
    if (read.kind === "event") {
      if (read.event.kind === "frame") held.frame = read.event.frame;
      emit(held, read.event);
    } else if (read.kind === "download") {
      void held.stream
        .write(`${JSON.stringify({ a: "take_download", guid: read.guid })}\n`)
        .catch(() => undefined);
    } else if (read.kind === "download-data") {
      void save(held, read.name, read.data);
    } else if (read.kind === "fatal") {
      held.reason = read.reason;
      teardown(held);
    }
  };

  const start = async (conversationId: string, options: CastOptions): Promise<Held> => {
    const seat = await deps.resolveOf(conversationId);
    if (seat.bot === undefined) throw new Error("this home has no browser (no per-bot users yet)");
    const stream = await deps.client.relay(seat.backend, CAST_TIMEOUT_MS);
    const held: Held = {
      conversationId,
      drive: options.drive === true,
      stream,
      listeners: new Set(),
      sizes: new Map(),
      frame: null,
      reason: "",
      dead: false,
      viewers: 0,
      idle: null,
    };
    let buffer = "";
    let stderrTail = "";
    stream.onChunk((chunk) => {
      if (!chunk.stdout) {
        stderrTail = `${stderrTail}${Buffer.from(chunk.data).toString("utf-8")}`.slice(-500);
        return;
      }
      buffer += Buffer.from(chunk.data).toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const text of lines) if (text.trim() !== "") onLine(held, text.trim());
    });
    stream.onExit((code) => {
      if (held.reason === "") {
        held.reason =
          stderrTail !== "" ? stderrTail.trim().slice(0, 300) : `the cast ended (${code})`;
      }
      teardown(held);
    });
    const request = {
      op: "cast",
      bot: seat.bot,
      drive: held.drive,
      w: clampSize(options.w, 320, 2560, 1280),
      h: clampSize(options.h, 240, 1600, 800),
    };
    await stream.write(`${JSON.stringify(request)}\n`);
    live.set(conversationId, held);
    return held;
  };

  const resize = (held: Held): void => {
    if (held.sizes.size === 0 || held.dead) return;
    const sizes = [...held.sizes.values()];
    const w = Math.max(...sizes.map((size) => size.w));
    const h = Math.max(...sizes.map((size) => size.h));
    void held.stream.write(`${JSON.stringify({ a: "size", w, h })}\n`).catch(() => undefined);
  };

  const attach = (held: Held, options: CastOptions): CastSession => {
    viewerSeq += 1;
    const viewer = viewerSeq;
    if (options.w !== undefined && options.h !== undefined) {
      held.sizes.set(viewer, {
        w: clampSize(options.w, 320, 2560, 1280),
        h: clampSize(options.h, 240, 1600, 800),
      });
      resize(held);
    }
    if (held.idle !== null) {
      clearTimeout(held.idle);
      held.idle = null;
    }
    held.viewers += 1;
    return {
      conversationId: held.conversationId,
      drive: held.drive,
      get frame(): CastFrame | null {
        return held.frame;
      },
      subscribe: (listener) => {
        held.listeners.add(listener);
        const current = held.frame;
        if (current !== null) listener({ kind: "frame", frame: current });
        return () => {
          held.listeners.delete(listener);
        };
      },
      act: async (input) => {
        if (held.dead) throw new Error("the cast is no longer live");
        await held.stream.write(`${JSON.stringify(input)}\n`);
      },
      release: () => {
        held.sizes.delete(viewer);
        held.viewers = Math.max(0, held.viewers - 1);
        if (held.viewers > 0 || held.dead) return;
        if (held.idle !== null) clearTimeout(held.idle);
        held.idle = setTimeout(() => {
          if (held.reason === "") held.reason = "the view was closed";
          teardown(held);
        }, idleMs);
        held.idle.unref?.();
      },
    };
  };

  const stopNow = async (conversationId: string, reason: string): Promise<void> => {
    const pending = starting.get(conversationId);
    if (pending !== undefined) {
      const held = await pending.catch(() => undefined);
      if (held !== undefined) {
        if (held.reason === "") held.reason = reason;
        teardown(held);
      }
    }
    const existing = live.get(conversationId);
    if (existing === undefined) return;
    if (existing.reason === "") existing.reason = reason;
    teardown(existing);
  };

  return {
    for: async (conversationId, options = {}) => {
      const drive = options.drive === true;
      const existing = live.get(conversationId);
      if (existing !== undefined && !existing.dead) {
        if (existing.drive === drive) return attach(existing, options);
        // Watch and drive never share a page: the new mode replaces the old.
        await stopNow(
          conversationId,
          drive ? "your owner took the controls" : "the takeover ended",
        );
      }
      let pending = starting.get(conversationId);
      if (pending === undefined) {
        pending = start(conversationId, options).finally(() => starting.delete(conversationId));
        starting.set(conversationId, pending);
      }
      return attach(await pending, options);
    },
    act: async (conversationId, input) => {
      const existing = live.get(conversationId);
      if (existing === undefined || existing.dead || !existing.drive) {
        throw new Error("the live view is not open — open it first");
      }
      await existing.stream.write(`${JSON.stringify(input)}\n`);
    },
    size: async (conversationId, w, h) => {
      const existing = live.get(conversationId);
      if (existing === undefined || existing.dead) return;
      existing.sizes.set(0, { w: clampSize(w, 320, 2560, 1280), h: clampSize(h, 240, 1600, 800) });
      resize(existing);
    },
    stop: (conversationId, reason = "the takeover ended") => stopNow(conversationId, reason),
  };
};
