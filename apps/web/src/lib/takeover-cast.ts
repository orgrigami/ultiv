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
import { openCastChannel, ssePath, type CastChannel, type CastSource } from "./cast-channel.ts";

export type { CastSource } from "./cast-channel.ts";

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
  /** The page text the owner last copied out (with when, to tell repeats apart). */
  readonly copied: { readonly text: string; readonly at: number } | null;
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
  | { a: "copy" }
  | { a: "dialog"; accept: boolean; text?: string }
  | { a: "upload"; name: string; data: string }
  | { a: "viewport"; w: number; h: number; mobile: boolean };

const TYPE_FLUSH_MS = 40;
const RESIZE_MS = 300;

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

/** The stream's state: frames, what the page waits on, what it saved. */
function useCastStream(from: CastSource, size: { w: number; h: number } | null) {
  const [status, setStatus] = useState<CastStatus>("connecting");
  const [frame, setFrame] = useState<CastFrameView | null>(null);
  const [dialog, setDialog] = useState<CastDialog | null>(null);
  const [chooser, setChooser] = useState<string | null>(null);
  const [saved, setSaved] = useState<readonly { id: string; name: string }[]>([]);
  const [copied, setCopied] = useState<{ text: string; at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const channel = useRef<CastChannel | null>(null);
  // The size the stream OPENS at; later changes go over `resize`.
  const opening = useRef(size);
  if (opening.current === null && size !== null) opening.current = size;
  const ready = size !== null;
  const path = ssePath(from);
  useEffect(() => {
    if (!ready) return;
    setStatus("connecting");
    const source: CastSource =
      from.kind === "takeover"
        ? { kind: "takeover", id: from.id }
        : { kind: "watch", conversationId: from.conversationId };
    const on = (event: string, data: unknown): void => {
      const body = (data ?? {}) as Record<string, unknown>;
      if (event === "ready") setStatus("live");
      else if (event === "frame") {
        setFrame(data as CastFrameView);
        setStatus("live");
      } else if (event === "dialog") setDialog(body.open === true ? (data as CastDialog) : null);
      else if (event === "chooser") setChooser(body.open === true ? String(body.mode ?? "") : null);
      else if (event === "saved")
        setSaved((rows) => [...rows, data as { id: string; name: string }].slice(-5));
      else if (event === "copied") setCopied({ text: String(body.text ?? ""), at: Date.now() });
      else if (event === "cast-error")
        setError(typeof body.error === "string" ? body.error : "the act failed");
      else if (event === "closed") {
        setStatus("ended");
        if (typeof body.reason === "string" && body.reason !== "the takeover ended")
          setError(body.reason);
      }
    };
    const opened = openCastChannel(source, opening.current, { on, status: setStatus });
    channel.current = opened;
    return () => {
      opened.close();
      if (channel.current === opened) channel.current = null;
    };
    // The source's identity is its path.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [path, attempt, ready]);
  const reopen = useCallback((): void => {
    setFrame(null);
    setDialog(null);
    setChooser(null);
    setAttempt((n) => n + 1);
  }, []);
  return { status, frame, dialog, chooser, saved, copied, error, setError, reopen, channel };
}

export const useBrowserCast = (
  from: CastSource,
  size: { w: number; h: number } | null = { w: 1280, h: 800 },
): TakeoverCast => {
  const id = from.kind === "takeover" ? from.id : null;
  const stream = useCastStream(from, size);
  const { setError, channel } = stream;
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
    if (text === "" || enqueue === null) return;
    if (channel.current?.send({ a: "type", text }) !== true)
      void enqueue({ a: "type", text }).catch(report);
  }, [enqueue, report, channel]);

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
      // The socket carries acts in order; without it, the POST queue does.
      if (channel.current?.send(act) !== true) void enqueue(act).catch(report);
    },
    [flush, enqueue, report, channel],
  );

  const path = ssePath(from);
  const resize = useCallback(
    (w: number, h: number): void => {
      if (resizeTimer.current !== null) clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(() => {
        const size = { a: "size", w: Math.round(w), h: Math.round(h) };
        if (channel.current?.send(size) === true) return;
        void api.browserCastSize(path, size.w, size.h).catch(() => undefined);
      }, RESIZE_MS);
    },
    [path, channel],
  );

  useEffect(() => () => flush(), [flush]);
  const dismissError = useCallback((): void => setError(null), [setError]);
  const { status, frame, dialog, chooser, saved, copied, error, reopen } = stream;
  return useMemo(
    () => ({
      status,
      frame,
      dialog,
      chooser,
      saved,
      copied,
      error,
      dismissError,
      reopen,
      send,
      flush,
      resize,
    }),
    [
      status,
      frame,
      dialog,
      chooser,
      saved,
      copied,
      error,
      dismissError,
      reopen,
      send,
      flush,
      resize,
    ],
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
