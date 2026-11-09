/**
 * The owner's side of a bot's live browser: the EventSource that carries
 * the cast (screencast frames as server-sent events, same-origin with the
 * session cookie), what the page waits on (a dialog, a file chooser), the
 * popup on show, the downloads saved to the bot's files, and the acts the
 * owner sends. Frames are sized to the picture on screen (`size`), so the
 * panel gets small ones and full screen sharp ones. The cast is push-only:
 * frames arrive as events, acts are ordinary POSTs — sent ONE AT A TIME, in
 * order: typed text then Enter must reach the page in that order, and two
 * concurrent POSTs land in whichever order the network picks. A WATCH cast
 * (a bot's browser with no takeover open) streams the same frames and never
 * sends an act.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.ts";
import type { PointerAct } from "./cast-pointer.ts";

export { imagePoint } from "./cast-pointer.ts";
export { keyDecision, PAGE_KEYS, type KeyDecision } from "./cast-keys.ts";

export interface CastFrameView {
  readonly id: string;
  readonly data: string;
  readonly mime: "image/jpeg" | "image/png";
  readonly w: number;
  readonly h: number;
  readonly url: string;
  readonly title: string;
  /** The page on show is a popup the bot's page opened. */
  readonly popup?: boolean;
}

export type CastStatus = "connecting" | "live" | "ended";

/** An alert/confirm/prompt the page is frozen on. */
export interface CastDialog {
  readonly type: string;
  readonly message: string;
  readonly default: string;
}

export interface TakeoverCast {
  readonly status: CastStatus;
  readonly frame: CastFrameView | null;
  readonly dialog: CastDialog | null;
  /** The page asked for a file (single or multiple). */
  readonly chooser: string | null;
  /** Downloads the page finished, saved into the bot's files. */
  readonly saved: readonly { readonly id: string; readonly name: string }[];
  /** The latest act error (a failed act; the cast keeps running). */
  readonly error: string | null;
  readonly dismissError: () => void;
  /** After an end (a timeout, a server restart that outlived retries). */
  readonly reopen: () => void;
  /** Send one act; typed text is buffered briefly so bursts land as one. */
  readonly send: (act: TakeoverAct) => void;
  /** Flush any buffered typing at once (on blur, on a different act). */
  readonly flush: () => void;
  /** The picture's size on screen changed (device pixels): frames follow. */
  readonly resize: (w: number, h: number) => void;
}

export type TakeoverAct =
  | PointerAct
  | { a: "type"; text: string }
  | { a: "key"; key: string }
  | { a: "scroll"; dx: number; dy: number }
  | { a: "nav"; url: string }
  | { a: "reload" }
  | { a: "back" }
  | { a: "dialog"; accept: boolean; text?: string }
  | { a: "upload"; name: string; data: string }
  | { a: "viewport"; w: number; h: number; mobile: boolean };

const TYPE_FLUSH_MS = 40;
const RESIZE_MS = 300;

/** What a cast streams: a takeover the owner drives, or a session they only watch. */
export type CastSource =
  | { readonly kind: "takeover"; readonly id: string }
  | { readonly kind: "watch"; readonly conversationId: string };

const basePath = (source: CastSource): string =>
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

const parsed = <T>(event: Event): T | null => {
  try {
    return JSON.parse((event as MessageEvent<string>).data) as T;
  } catch {
    return null;
  }
};

/** The stream's state: frames, what the page waits on, what it saved. */
function useCastStream(from: CastSource, size: { w: number; h: number } | null) {
  const [status, setStatus] = useState<CastStatus>("connecting");
  const [frame, setFrame] = useState<CastFrameView | null>(null);
  const [dialog, setDialog] = useState<CastDialog | null>(null);
  const [chooser, setChooser] = useState<string | null>(null);
  const [saved, setSaved] = useState<readonly { id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The size the stream OPENS at; later changes go over `resize`.
  const opening = useRef(size);
  if (opening.current === null && size !== null) opening.current = size;
  const ready = size !== null;
  const path = basePath(from);
  useEffect(() => {
    if (!ready) return;
    setStatus("connecting");
    const at = opening.current;
    const query = at === null ? "" : `?w=${at.w}&h=${at.h}`;
    const es = new EventSource(`${path}${query}`);
    es.addEventListener("ready", () => setStatus("live"));
    es.addEventListener("frame", (event) => {
      const next = parsed<CastFrameView>(event);
      if (next === null) return;
      setFrame(next);
      setStatus("live");
    });
    es.addEventListener("dialog", (event) => {
      const next = parsed<CastDialog & { open: boolean }>(event);
      setDialog(next?.open === true ? next : null);
    });
    es.addEventListener("chooser", (event) => {
      const next = parsed<{ open: boolean; mode: string }>(event);
      setChooser(next?.open === true ? next.mode : null);
    });
    es.addEventListener("saved", (event) => {
      const next = parsed<{ id: string; name: string }>(event);
      if (next !== null) setSaved((rows) => [...rows, next].slice(-5));
    });
    es.addEventListener("cast-error", (event) => {
      setError(parsed<{ error?: string }>(event)?.error ?? "the act failed");
    });
    es.addEventListener("closed", (event) => {
      es.close();
      setStatus("ended");
      const reason = parsed<{ reason?: string }>(event)?.reason;
      if (reason !== undefined && reason !== "the takeover ended") setError(reason);
    });
    es.onerror = () => {
      // A dropped connection RECONNECTS by itself (the retry hint); only a
      // server-side end (readyState CLOSED) leaves the view ended.
      setStatus(es.readyState === EventSource.CLOSED ? "ended" : "connecting");
    };
    return () => es.close();
  }, [path, attempt, ready]);
  const reopen = useCallback((): void => {
    setFrame(null);
    setDialog(null);
    setChooser(null);
    setAttempt((n) => n + 1);
  }, []);
  return { status, frame, dialog, chooser, saved, error, setError, reopen };
}

export const useBrowserCast = (
  from: CastSource,
  size: { w: number; h: number } | null = { w: 1280, h: 800 },
): TakeoverCast => {
  const id = from.kind === "takeover" ? from.id : null;
  const stream = useCastStream(from, size);
  const { setError } = stream;
  const typing = useRef("");
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One queue per takeover: every act (typing included) goes through it.
  const enqueue = useMemo(
    () => (id === null ? null : actQueue((act) => api.browserTakeoverCastAct(id, act))),
    [id],
  );
  const report = useCallback(
    (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    [setError],
  );

  const flush = useCallback((): void => {
    if (typingTimer.current !== null) {
      clearTimeout(typingTimer.current);
      typingTimer.current = null;
    }
    const text = typing.current;
    typing.current = "";
    if (text !== "" && enqueue !== null) void enqueue({ a: "type", text }).catch(report);
  }, [enqueue, report]);

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
      void enqueue(act).catch(report);
    },
    [flush, enqueue, report],
  );

  const path = basePath(from);
  const resize = useCallback(
    (w: number, h: number): void => {
      if (resizeTimer.current !== null) clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(() => {
        void api.browserCastSize(path, Math.round(w), Math.round(h)).catch(() => undefined);
      }, RESIZE_MS);
    },
    [path],
  );

  useEffect(() => () => flush(), [flush]);
  const dismissError = useCallback((): void => setError(null), [setError]);
  const { status, frame, dialog, chooser, saved, error, reopen } = stream;
  return useMemo(
    () => ({
      status,
      frame,
      dialog,
      chooser,
      saved,
      error,
      dismissError,
      reopen,
      send,
      flush,
      resize,
    }),
    [status, frame, dialog, chooser, saved, error, dismissError, reopen, send, flush, resize],
  );
};

/** The takeover's driving cast (kept for the takeover card). */
export const useTakeoverCast = (
  id: string,
  size: { w: number; h: number } | null = { w: 1280, h: 800 },
): TakeoverCast =>
  useBrowserCast(
    useMemo(() => ({ kind: "takeover" as const, id }), [id]),
    size,
  );
