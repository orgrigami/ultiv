/**
 * One chat, live, for the TUI: a chord link to the server (reopened with
 * backoff when it drops — a server restart, a laptop that slept), the open
 * Session ref, and its snapshot. Actions resolve when the server accepted
 * them and reject otherwise; the view words the failure.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { SendMode } from "@spriessen/contracts";
import { reconnectDelay } from "../client/backoff.ts";
import {
  connectLink,
  EMPTY_SNAPSHOT,
  watchSession,
  type SessionRef,
  type SessionSnapshot,
} from "../client/session.ts";

export type LinkState = "connecting" | "connected" | "disconnected";

export interface Chat {
  readonly link: LinkState;
  readonly snapshot: SessionSnapshot;
  readonly send: (text: string, mode?: SendMode) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly decide: (approved: boolean, always?: boolean) => Promise<void>;
  readonly retryQueued: () => Promise<void>;
}

export const useChat = (server: string, cookie: string, chatId: string | undefined): Chat => {
  const [link, setLink] = useState<LinkState>("connecting");
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(EMPTY_SNAPSHOT);
  const [epoch, setEpoch] = useState(0);
  const ref = useRef<SessionRef | undefined>(undefined);
  const attempts = useRef(0);

  useEffect(() => {
    if (chatId === undefined) return;
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const cleanups: Array<() => void> = [];
    const lost = (): void => {
      if (!active || retry !== undefined) return;
      ref.current = undefined;
      setLink("disconnected");
      retry = setTimeout(() => setEpoch((n) => n + 1), reconnectDelay(attempts.current++));
    };
    setLink("connecting");
    connectLink(server, cookie)
      .then(async (opened) => {
        if (!active) return opened.close();
        cleanups.push(() => opened.close(), opened.onClosed(lost));
        const session = await opened.open(chatId);
        if (!active) return session.release();
        ref.current = session;
        attempts.current = 0;
        setLink("connected");
        cleanups.push(
          watchSession(session, setSnapshot),
          () => session.release(),
          session.onStatus((status) => {
            if (status === "gone") lost();
          }),
        );
      })
      .catch(lost);
    return () => {
      active = false;
      if (retry !== undefined) clearTimeout(retry);
      for (const cleanup of cleanups.reverse()) {
        try {
          cleanup();
        } catch {
          // A dead link has nothing left to release.
        }
      }
      ref.current = undefined;
    };
  }, [server, cookie, chatId, epoch]);

  // A different chat starts blank, never with the last one's lines.
  useEffect(() => setSnapshot(EMPTY_SNAPSHOT), [chatId]);

  const linked = useCallback((): SessionRef => {
    if (ref.current === undefined) throw new Error("not connected");
    return ref.current;
  }, []);

  const send = useCallback(
    async (text: string, mode?: SendMode) => {
      await linked().input({ text, ...(mode !== undefined ? { whenBusy: mode } : {}) });
    },
    [linked],
  );
  const stop = useCallback(async () => {
    await linked().interrupt({});
  }, [linked]);
  const decide = useCallback(
    async (approved: boolean, always?: boolean) => {
      const pending = snapshot.pending;
      if (pending === null) return;
      await linked().approve({
        callId: pending.callId,
        approved,
        ...(always === true ? { always: true } : {}),
      });
    },
    [linked, snapshot.pending],
  );
  const retryQueued = useCallback(async () => {
    await linked().retryQueued({});
  }, [linked]);

  return { link, snapshot, send, stop, decide, retryQueued };
};
