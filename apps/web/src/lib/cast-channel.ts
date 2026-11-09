/**
 * The live cast's wire, on the owner's side: ONE WebSocket at `/cast`
 * (frames and events down, acts up, in order, no request per keystroke),
 * falling back to the server-sent event stream (with acts as POSTs) when the
 * socket cannot open — an old server, a proxy that strips upgrades. Both
 * deliver the same named events to `on`; `send` reports whether the socket
 * carried the act (false: post it instead).
 */
export type CastSource =
  | { readonly kind: "takeover"; readonly id: string }
  | { readonly kind: "watch"; readonly conversationId: string };

/** The SSE stream's path (also the base of the act and size POSTs). */
export const ssePath = (source: CastSource): string =>
  source.kind === "takeover"
    ? `/api/browser/takeover/${encodeURIComponent(source.id)}/cast`
    : `/api/browser/sessions/${encodeURIComponent(source.conversationId)}/cast`;

/** The socket's same-origin URL for a source and an opening size. */
export const socketUrl = (
  source: CastSource,
  size: { w: number; h: number } | null,
  at: { protocol: string; host: string },
): string => {
  const scheme = at.protocol === "https:" ? "wss" : "ws";
  const view =
    source.kind === "takeover"
      ? `takeover=${encodeURIComponent(source.id)}`
      : `watch=${encodeURIComponent(source.conversationId)}`;
  const dims = size === null ? "" : `&w=${size.w}&h=${size.h}`;
  return `${scheme}://${at.host}/cast?${view}${dims}`;
};

export interface CastChannel {
  /** Send over the socket; false when the socket is not the wire (POST instead). */
  readonly send: (body: unknown) => boolean;
  readonly close: () => void;
}

export interface ChannelHandlers {
  /** One named event with its parsed data. */
  readonly on: (event: string, data: unknown) => void;
  /** The wire is (re)connecting or ended for good. */
  readonly status: (status: "connecting" | "ended") => void;
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const EVENTS = ["ready", "frame", "page", "dialog", "chooser", "saved", "cast-error", "closed"];

const openSse = (
  path: string,
  size: { w: number; h: number } | null,
  handlers: ChannelHandlers,
) => {
  const query = size === null ? "" : `?w=${size.w}&h=${size.h}`;
  const es = new EventSource(`${path}${query}`);
  for (const name of EVENTS) {
    es.addEventListener(name, (event) => {
      if (name === "closed") es.close();
      handlers.on(name, parse((event as MessageEvent<string>).data));
    });
  }
  es.onerror = () => {
    // A dropped connection RECONNECTS by itself (the retry hint); only a
    // server-side end (readyState CLOSED) leaves the view ended.
    handlers.status(es.readyState === EventSource.CLOSED ? "ended" : "connecting");
  };
  return es;
};

/** Open the cast: the socket first, the event stream if the socket never opens. */
export const openCastChannel = (
  source: CastSource,
  size: { w: number; h: number } | null,
  handlers: ChannelHandlers,
): CastChannel => {
  let socket: WebSocket | null = null;
  let sse: EventSource | null = null;
  let closed = false;
  const fallback = (): void => {
    if (!closed && sse === null) sse = openSse(ssePath(source), size, handlers);
  };
  if (typeof WebSocket === "undefined") fallback();
  else {
    const ws = new WebSocket(socketUrl(source, size, globalThis.location));
    socket = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
    };
    ws.onmessage = (event: MessageEvent<string>) => {
      const message = parse(event.data) as { event?: string; data?: unknown } | null;
      if (message?.event !== undefined) handlers.on(message.event, message.data);
    };
    ws.onclose = () => {
      socket = null;
      if (closed) return;
      // Never opened: this wire is not available here; the stream is.
      if (!opened) fallback();
      else handlers.status("ended");
    };
  }
  return {
    send: (body) => {
      const ws = socket;
      if (ws === null || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(body));
      return true;
    },
    close: () => {
      closed = true;
      socket?.close(1000);
      sse?.close();
    },
  };
};
