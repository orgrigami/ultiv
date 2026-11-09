/**
 * The owner's side of a live browser takeover: the EventSource that carries
 * the cast (screencast frames as server-sent events, same-origin with the
 * session cookie) and the small pure helpers the driving view needs —
 * display-pixel to frame-pixel mapping for taps, and the keyboard decision
 * (which keystrokes belong to the page, which stay with the app). The cast
 * is push-only: frames arrive as events, acts are ordinary POSTs — sent ONE
 * AT A TIME, in order: typed text then Enter must reach the page in that
 * order, and two concurrent POSTs land in whichever order the network picks.
 * A WATCH cast (a bot's browser with no takeover open) streams the same
 * frames and never sends an act.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.ts";

export interface CastFrameView {
  readonly id: string;
  readonly data: string;
  readonly mime: "image/jpeg" | "image/png";
  readonly w: number;
  readonly h: number;
  readonly url: string;
  readonly title: string;
}

export type CastStatus = "connecting" | "live" | "ended";

export interface TakeoverCast {
  readonly status: CastStatus;
  readonly frame: CastFrameView | null;
  /** The latest act error (a failed act; the cast keeps running). */
  readonly error: string | null;
  readonly dismissError: () => void;
  /** After an end (a timeout, a server restart that outlived retries). */
  readonly reopen: () => void;
  /** Send one act; typed text is buffered briefly so bursts land as one. */
  readonly send: (act: TakeoverAct) => void;
  /** Flush any buffered typing at once (on blur, on a different act). */
  readonly flush: () => void;
}

export type TakeoverAct =
  | { a: "tap"; x: number; y: number; id: string }
  | { a: "type"; text: string }
  | { a: "key"; key: string }
  | { a: "scroll"; dx: number; dy: number }
  | { a: "nav"; url: string }
  | { a: "reload" };

/** A point on the DISPLAYED image, in its own pixels. */
export const imagePoint = (
  frame: { readonly w: number; readonly h: number },
  displayWidth: number,
  at: { readonly x: number; readonly y: number },
): { x: number; y: number } => {
  const scale = displayWidth > 0 ? frame.w / displayWidth : 1;
  return {
    x: Math.max(0, Math.min(frame.w - 1, Math.round(at.x * scale))),
    y: Math.max(0, Math.min(frame.h - 1, Math.round(at.y * scale))),
  };
};

/** Named keys the page understands (mirrors the cast driver's table). */
export const PAGE_KEYS: ReadonlySet<string> = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "ArrowLeft",
  "ArrowUp",
  "ArrowRight",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

export type KeyDecision =
  | { readonly send: "type"; readonly text: string }
  | { readonly send: "key"; readonly key: string }
  | { readonly send: "escape" }
  | { readonly send: "passthrough" };

/**
 * What one keystroke means while the live view holds focus: printable text
 * and the page's named keys go to the page, Escape releases focus back to
 * the app, and anything with a modifier (the browser's and the app's own
 * shortcuts) never reaches the bot's browser.
 */
export const keyDecision = (key: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}): KeyDecision => {
  if (key.ctrlKey || key.metaKey || key.altKey) return { send: "passthrough" };
  if (key.key === "Escape") return { send: "escape" };
  if (PAGE_KEYS.has(key.key)) return { send: "key", key: key.key };
  // A bare key of length 1 is a printable character (space, letters, punctuation).
  if (key.key.length === 1) return { send: "type", text: key.key };
  return { send: "passthrough" };
};

const TYPE_FLUSH_MS = 40;

/** What a cast streams: a takeover the owner drives, or a session they only watch. */
export type CastSource =
  | { readonly kind: "takeover"; readonly id: string }
  | { readonly kind: "watch"; readonly conversationId: string };

const streamUrl = (source: CastSource): string =>
  source.kind === "takeover"
    ? `/api/browser/takeover/${encodeURIComponent(source.id)}/cast`
    : `/api/browser/sessions/${encodeURIComponent(source.conversationId)}/cast`;

/** A queue that runs one POST at a time, in the order they were sent. */
export const actQueue = (post: (act: TakeoverAct) => Promise<unknown>) => {
  let tail: Promise<unknown> = Promise.resolve();
  return (act: TakeoverAct): Promise<unknown> => {
    const next = tail.then(() => post(act));
    // A failed act never blocks the ones after it.
    tail = next.catch(() => undefined);
    return next;
  };
};

export const useBrowserCast = (from: CastSource): TakeoverCast => {
  const id = from.kind === "takeover" ? from.id : null;
  const url = streamUrl(from);
  const [status, setStatus] = useState<CastStatus>("connecting");
  const [frame, setFrame] = useState<CastFrameView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const source = useRef<EventSource | null>(null);
  const typing = useRef("");
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setStatus("connecting");
    const es = new EventSource(url);
    source.current = es;
    const onFrame = (event: MessageEvent<string>): void => {
      try {
        setFrame(JSON.parse(event.data) as CastFrameView);
        setStatus("live");
      } catch {
        // A malformed frame is dropped; the next one repaints.
      }
    };
    es.addEventListener("ready", () => setStatus("live"));
    es.addEventListener("frame", (event) => onFrame(event as MessageEvent<string>));
    es.addEventListener("cast-error", (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent<string>).data) as { error?: string };
        setError(parsed.error ?? "the act failed");
      } catch {
        setError("the act failed");
      }
    });
    es.addEventListener("closed", (event) => {
      es.close();
      source.current = null;
      setStatus("ended");
      try {
        const parsed = JSON.parse((event as MessageEvent<string>).data) as { reason?: string };
        if (parsed.reason !== undefined && parsed.reason !== "the takeover ended") {
          setError(parsed.reason);
        }
      } catch {
        // The reason is optional.
      }
    });
    es.onerror = () => {
      // A dropped connection RECONNECTS by itself (the retry hint); only a
      // server-side end (readyState CLOSED) leaves the view ended.
      if (es.readyState === EventSource.CLOSED) setStatus("ended");
      else setStatus("connecting");
    };
    return () => {
      es.close();
      source.current = null;
    };
  }, [url, attempt]);

  // One queue per takeover: every act (typing included) goes through it.
  const enqueue = useMemo(
    () => (id === null ? null : actQueue((act) => api.browserTakeoverCastAct(id, act))),
    [id],
  );

  const flush = useCallback((): void => {
    if (typingTimer.current !== null) {
      clearTimeout(typingTimer.current);
      typingTimer.current = null;
    }
    const text = typing.current;
    typing.current = "";
    if (text !== "" && enqueue !== null) {
      void enqueue({ a: "type", text }).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    }
  }, [enqueue]);

  const send = useCallback(
    (act: TakeoverAct): void => {
      if (enqueue === null) return;
      if (act.a === "type") {
        // A burst of keystrokes lands as one insertText — one POST, one
        // input event, the way a fast typist reads to the page.
        typing.current += act.text;
        if (typingTimer.current !== null) clearTimeout(typingTimer.current);
        typingTimer.current = setTimeout(flush, TYPE_FLUSH_MS);
        return;
      }
      flush();
      void enqueue(act).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    },
    [flush, enqueue],
  );

  useEffect(() => () => flush(), [flush]);

  const reopen = useCallback((): void => {
    setFrame(null);
    setAttempt((n) => n + 1);
  }, []);

  const dismissError = useCallback((): void => setError(null), []);

  return useMemo(
    () => ({ status, frame, error, dismissError, reopen, send, flush }),
    [status, frame, error, dismissError, reopen, send, flush],
  );
};

/** The takeover's driving cast (kept for the takeover card). */
export const useTakeoverCast = (id: string): TakeoverCast =>
  useBrowserCast(useMemo(() => ({ kind: "takeover" as const, id }), [id]));
