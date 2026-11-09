/**
 * The live browser cast over ONE WebSocket at `/cast`: frames and events
 * down, the owner's acts up, in order, on a single connection — no request
 * per keystroke, no separate act POSTs. Cookie-authenticated on the upgrade
 * like `/push` (main.ts routes it after the session check). The same rules
 * as the SSE routes: `?takeover=<id>` drives an open ask on the caller's
 * own bot (acts accepted, checked by `castActOf`); `?watch=<conversationId>`
 * only streams a session no takeover holds (acts refused). Another owner's
 * ask or session closes the socket exactly like a missing one. Frames are
 * newest-only while the socket is behind; other events are never dropped.
 * The SSE stream and the act POSTs stay as the fallback (docs/LIVE.md).
 */
import { WebSocketServer, type WebSocket } from "ws";
import type { MindService } from "@spriessen/mind";
import type { CastEvent, CastFrame, CastSession } from "@spriessen/ext";
import { can } from "./rest/can.ts";
import { castActOf, viewSizeOf } from "./rest/browser-cast.ts";
import { OWNER_ID } from "./identity.ts";

export const CAST_PATH = "/cast";

/** Bytes the socket may hold before frames start to wait (newest only). */
const FRAME_BACKLOG = 400_000;

type Target = {
  readonly conversationId: string;
  readonly drive: boolean;
  readonly live: () => boolean;
};

/** What the socket may show, or undefined (missing and not-yours look the same). */
const targetOf = (mind: MindService, url: URL): Target | undefined => {
  const askId = url.searchParams.get("takeover");
  const watch = url.searchParams.get("watch");
  const may = (conversationId: string, action: "view" | "change"): boolean => {
    const scope = mind.profiles.scopeOf(conversationId);
    return (
      scope !== undefined &&
      can(OWNER_ID, action, { type: "chat", owner: scope.owner, id: conversationId })
    );
  };
  if (askId !== null) {
    const row = mind.browserTakeovers?.get(askId);
    if (row === undefined || !may(row.conversationId, "change")) return undefined;
    return {
      conversationId: row.conversationId,
      drive: true,
      live: () => mind.browserTakeovers?.get(askId) !== undefined,
    };
  }
  if (watch !== null) {
    const live = (): boolean =>
      mind.browserSessions?.get(watch) !== undefined &&
      mind.browserTakeovers?.holds(watch) !== true;
    if (!may(watch, "view") || !live()) return undefined;
    return { conversationId: watch, drive: false, live };
  }
  return undefined;
};

const frameBody = (frame: CastFrame) => {
  const { id, data, mime, w, h, url, title, popup } = frame;
  return { id, data, mime, w, h, url, title, popup };
};

/** Pipe one cast session into one socket, both ways. */
const pipe = (client: WebSocket, session: CastSession, target: Target, mind: MindService): void => {
  const send = (event: string, data: unknown): void => {
    if (client.readyState === client.OPEN) client.send(JSON.stringify({ event, data }));
  };
  let pending: CastFrame | null = null;
  const drain = setInterval(() => {
    if (pending !== null && client.bufferedAmount < FRAME_BACKLOG) {
      send("frame", frameBody(pending));
      pending = null;
    }
  }, 50);
  const off = session.subscribe((event: CastEvent) => {
    if (event.kind === "frame") {
      if (client.bufferedAmount > FRAME_BACKLOG) pending = event.frame;
      else send("frame", frameBody(event.frame));
    } else if (event.kind === "ready") send("ready", { drive: session.drive });
    else if (event.kind === "error") send("cast-error", { error: event.error });
    else if (event.kind === "closed") {
      send("closed", { reason: event.reason });
      client.close(1000);
    } else {
      const { kind, ...data } = event;
      send(kind, data);
    }
  });
  client.on("message", (raw) => {
    let body: unknown;
    try {
      body = JSON.parse(String(raw));
    } catch {
      return;
    }
    const size = body as { a?: unknown; w?: unknown; h?: unknown };
    if (size.a === "size") {
      const view = viewSizeOf(size.w, size.h);
      if (view !== undefined) void mind.browserCasts?.size(target.conversationId, view.w, view.h);
      return;
    }
    const act = target.drive && target.live() ? castActOf(body) : undefined;
    if (act === undefined) {
      send("cast-error", {
        error: target.drive
          ? "that act is not one the page takes"
          : "watching never touches the page",
      });
      return;
    }
    // Typed into the page, never logged.
    session
      .act(act)
      .catch((cause: unknown) => send("cast-error", { error: String(cause).slice(0, 200) }));
  });
  client.on("close", () => {
    clearInterval(drain);
    off();
    session.release();
  });
};

/** The `/cast` socket server; main.ts hands it upgrades that passed the session check. */
export const castSockets = (mind: MindService): WebSocketServer => {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 40 * 1024 * 1024 });
  wss.on("connection", (client, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const target = mind.browserCasts === undefined ? undefined : targetOf(mind, url);
    if (target === undefined) {
      client.close(4404, "that view is no longer open");
      return;
    }
    const view = viewSizeOf(url.searchParams.get("w"), url.searchParams.get("h"));
    void mind.browserCasts
      ?.for(target.conversationId, { drive: target.drive, ...view })
      .then((session) => {
        if (client.readyState !== client.OPEN || !target.live()) {
          session.release();
          client.close(4404, "that view is no longer open");
          return;
        }
        pipe(client, session, target, mind);
      })
      .catch((cause: unknown) => client.close(4503, String(cause).slice(0, 120)));
  });
  return wss;
};
