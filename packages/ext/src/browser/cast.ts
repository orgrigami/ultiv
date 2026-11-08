/**
 * The owner's LIVE cast over a bot's browser: one in-VM driver process per
 * conversation (browser/cast-driver.ts) held open on the streaming exec,
 * its screencast frames fanned out to every viewer and the owner's input
 * acts written to its stdin. This is the takeover's driving seat — the
 * owner points and types at the picture, and REAL Input events reach the
 * page. One process serves any number of viewers (two devices, one
 * browser); when the last viewer leaves, the cast winds down after a grace
 * so a tab switch does not restart it, and it dies outright at the stream's
 * timeout. Nothing here polls: frames are push, acts are calls.
 */
import type { ShellBackend, ShellStream } from "../shell/backend.ts";
import { CAST_TIMEOUT_MS, castLaunchScript } from "./cast-driver.ts";

/** One screencast frame, everything the view needs to paint and map clicks. */
export interface CastFrame {
  readonly id: string;
  /** The image, base64 (a JPEG the driver asks for; PNG if chromium insists). */
  readonly data: string;
  readonly mime: "image/jpeg" | "image/png";
  readonly w: number;
  readonly h: number;
  readonly url: string;
  readonly title: string;
  readonly at: number;
}

/** One owner act, dispatched into the page as trusted input. */
export type CastAct =
  | { readonly a: "tap"; readonly x: number; readonly y: number; readonly id: string }
  | { readonly a: "type"; readonly text: string }
  | { readonly a: "key"; readonly key: string }
  | { readonly a: "scroll"; readonly dx: number; readonly dy: number }
  | { readonly a: "nav"; readonly url: string }
  | { readonly a: "reload" };

export type CastEvent =
  | { readonly kind: "ready" }
  | { readonly kind: "frame"; readonly frame: CastFrame }
  | { readonly kind: "error"; readonly error: string }
  | { readonly kind: "closed"; readonly reason: string };

export interface CastSession {
  readonly conversationId: string;
  /** The newest frame the cast produced (a late viewer paints instantly). */
  readonly frame: CastFrame | null;
  /** Subscribe from now on; the CURRENT frame (if any) is delivered first. */
  readonly subscribe: (listener: (event: CastEvent) => void) => () => void;
  /** One owner act; resolves once written, rejects when the cast is dead. */
  readonly act: (input: CastAct) => Promise<void>;
  /** A viewer left; the cast winds down once the last one has. */
  readonly release: () => void;
}

export interface CastSessions {
  /** Start (or attach to) a conversation's cast and count one viewer. */
  readonly for: (conversationId: string) => Promise<CastSession>;
  /** One act on a LIVE cast, without counting a viewer (the act routes). */
  readonly act: (conversationId: string, act: CastAct) => Promise<void>;
  /** End a conversation's cast now (a finished or cancelled takeover). */
  readonly stop: (conversationId: string) => Promise<void>;
}

export interface CastDeps {
  /** The home VM's backend for the conversation (browser/backends.ts). */
  readonly resolveOf: (conversationId: string) => Promise<{ backend: ShellBackend }>;
  /** How long a cast with no viewers lingers before it stops. */
  readonly idleMs?: number;
}

const mimeOf = (data: string): "image/jpeg" | "image/png" =>
  data.startsWith("/9j/") ? "image/jpeg" : "image/png";

interface Held {
  readonly conversationId: string;
  readonly stream: ShellStream;
  readonly listeners: Set<(event: CastEvent) => void>;
  frame: CastFrame | null;
  reason: string;
  dead: boolean;
  viewers: number;
  idle: ReturnType<typeof setTimeout> | null;
}

export const castSessions = (deps: CastDeps): CastSessions => {
  const idleMs = deps.idleMs ?? 8_000;
  const live = new Map<string, Held>();

  const teardown = (held: Held): void => {
    if (held.dead) return;
    held.dead = true;
    if (held.idle !== null) clearTimeout(held.idle);
    if (live.get(held.conversationId) === held) live.delete(held.conversationId);
    void held.stream.stop().catch(() => undefined);
    for (const listener of held.listeners) {
      listener({ kind: "closed", reason: held.reason === "" ? "the cast ended" : held.reason });
    }
  };

  const start = async (conversationId: string): Promise<Held> => {
    const { backend } = await deps.resolveOf(conversationId);
    if (backend.stream === undefined) {
      throw new Error("this browser backend cannot stream a live view");
    }
    const held: Held = {
      conversationId,
      stream: await backend.stream(castLaunchScript(), "/home", CAST_TIMEOUT_MS),
      listeners: new Set(),
      frame: null,
      reason: "",
      dead: false,
      viewers: 0,
      idle: null,
    };

    const emit = (event: CastEvent): void => {
      for (const listener of held.listeners) listener(event);
    };

    const onLine = (text: string): void => {
      if (!text.startsWith("{")) return;
      const parsed = safeJson(text);
      if (parsed === undefined) return;
      if (parsed.t === "frame") {
        const data = typeof parsed.data === "string" ? parsed.data : "";
        const w = Number(parsed.w);
        const h = Number(parsed.h);
        if (data === "" || !Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) {
          return;
        }
        const frame: CastFrame = {
          id: typeof parsed.id === "string" ? parsed.id : "",
          data,
          mime: mimeOf(data),
          w,
          h,
          url: typeof parsed.url === "string" ? parsed.url : "",
          title: typeof parsed.title === "string" ? parsed.title : "",
          at: Date.now(),
        };
        held.frame = frame;
        emit({ kind: "frame", frame });
      } else if (parsed.t === "ready") {
        emit({ kind: "ready" });
      } else if (parsed.t === "error") {
        emit({ kind: "error", error: String(parsed.error ?? "the act failed").slice(0, 300) });
      } else if (parsed.t === "fatal") {
        held.reason = String(parsed.error ?? "the cast could not start").slice(0, 300);
        teardown(held);
      }
    };

    let buffer = "";
    let stderrTail = "";
    held.stream.onChunk((chunk) => {
      if (!chunk.stdout) {
        stderrTail = `${stderrTail}${Buffer.from(chunk.data).toString("utf-8")}`.slice(-500);
        return;
      }
      buffer += Buffer.from(chunk.data).toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const text of lines) {
        const trimmed = text.trim();
        if (trimmed !== "") onLine(trimmed);
      }
    });
    held.stream.onExit((code) => {
      if (held.reason === "") {
        held.reason =
          stderrTail !== "" ? stderrTail.trim().slice(0, 300) : `the cast ended (${code})`;
      }
      teardown(held);
    });

    live.set(conversationId, held);
    return held;
  };

  const attach = (held: Held): CastSession => ({
    conversationId: held.conversationId,
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
      held.viewers = Math.max(0, held.viewers - 1);
      if (held.viewers > 0 || held.dead) return;
      if (held.idle !== null) clearTimeout(held.idle);
      held.idle = setTimeout(() => {
        if (held.reason === "") held.reason = "the view was closed";
        teardown(held);
      }, idleMs);
      held.idle.unref?.();
    },
  });

  return {
    for: async (conversationId) => {
      const existing = live.get(conversationId);
      if (existing !== undefined && !existing.dead) {
        if (existing.idle !== null) {
          clearTimeout(existing.idle);
          existing.idle = null;
        }
        existing.viewers += 1;
        return attach(existing);
      }
      const fresh = await start(conversationId);
      fresh.viewers += 1;
      return attach(fresh);
    },
    act: async (conversationId, input) => {
      const existing = live.get(conversationId);
      if (existing === undefined || existing.dead) {
        throw new Error("the live view is not open — open it first");
      }
      await existing.stream.write(`${JSON.stringify(input)}\n`);
    },
    stop: async (conversationId) => {
      const existing = live.get(conversationId);
      if (existing === undefined) return;
      if (existing.reason === "") existing.reason = "the takeover ended";
      teardown(existing);
    },
  };
};

const safeJson = (text: string): { readonly [key: string]: unknown } | undefined => {
  try {
    return JSON.parse(text) as { readonly [key: string]: unknown };
  } catch {
    return undefined;
  }
};
