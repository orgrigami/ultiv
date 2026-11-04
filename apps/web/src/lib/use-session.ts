import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PendingApproval,
  Phase,
  QueuedInput,
  ThinkingLevel,
  TranscriptEntry,
  UsageSummary,
  SendMode,
} from "@spriessen/contracts";
import { onLinkClosed, openSession, reconnectDelay, type SessionRef } from "./chord.ts";

export type LinkPhase = "connecting" | "live" | "lost";

type CellSetters = {
  transcript: (value: TranscriptEntry[]) => void;
  queued: (value: QueuedInput[]) => void;
  conversationId: (value: string) => void;
  loaded: () => void;
};

/**
 * Holds a fresh Session object's transcript and queue back until the server
 * has loaded the conversation. A new object starts empty and publishes its
 * history only after attach settles; showing that empty start would flash
 * the "new chat" screen on every open and blank the chat on every
 * reconnect. The server sets `conversationId` only after its first load,
 * so that cell is the signal.
 */
export function bindLoadedCells(opened: SessionRef, set: CellSetters): Array<() => void> {
  let loaded = false;
  const held: { transcript?: TranscriptEntry[]; queued?: QueuedInput[] } = {};
  return [
    opened.transcript.subscribe((value) => {
      if (loaded) set.transcript(value);
      else held.transcript = value;
    }),
    opened.queued.subscribe((value) => {
      if (loaded) set.queued(value);
      else held.queued = value;
    }),
    opened.conversationId.subscribe((value) => {
      if (value === null) return;
      set.conversationId(value);
      if (loaded) return;
      loaded = true;
      set.transcript(held.transcript ?? []);
      set.queued(held.queued ?? []);
      set.loaded();
    }),
  ];
}

export function useSession(sessionId: string): {
  link: LinkPhase;
  /** The server has loaded this chat's history (until then an empty transcript means "not yet"). */
  loaded: boolean;
  transcript: TranscriptEntry[];
  phase: Phase;
  lastError: string | null;
  pending: PendingApproval;
  usage: UsageSummary | null;
  model: string | null;
  effort: ThinkingLevel | null;
  conversationId: string | null;
  /** Messages waiting for the running turn, oldest first. */
  queued: QueuedInput[];
  /** Send; while the bot works, `whenBusy` picks steer (default), followUp, or redirect. */
  input: (text: string, whenBusy?: SendMode, attachments?: string[]) => Promise<void>;
  /** Take back a queued message. */
  withdraw: (id: string) => Promise<void>;
  /** Send the queue a failed or cut-off turn left behind (never sent by itself). */
  retryQueued: () => Promise<void>;
  decide: (
    callId: string,
    approved: boolean,
    always?: boolean,
    takeover?: boolean,
    input?: unknown,
  ) => Promise<{ stored: number | null }>;
  configure: (model: string | null, effort: ThinkingLevel | null) => Promise<void>;
  /** Stop the reply; with `tasks`, also this chat's running background tasks. */
  interrupt: (tasks?: boolean) => Promise<void>;
} {
  const [link, setLink] = useState<LinkPhase>("connecting");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [lastError, setLastError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingApproval>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<ThinkingLevel | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [queued, setQueued] = useState<QueuedInput[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [ref, setRef] = useState<SessionRef | undefined>(undefined);
  // Bumped to reopen the session after the link dropped; the transcript
  // stays on screen meanwhile and is replaced by the fresh one.
  const [epoch, setEpoch] = useState(0);
  const attempts = useRef(0);

  // Everything shown belongs to one session: clear it only when that changes.
  useEffect(
    () => () => {
      attempts.current = 0;
      setLink("connecting");
      setTranscript([]);
      setPhase("idle");
      setLastError(null);
      setPending(null);
      setUsage(null);
      setModel(null);
      setEffort(null);
      setConversationId(null);
      setQueued([]);
      setLoaded(false);
    },
    [sessionId],
  );

  useEffect(() => {
    let active = true;
    let current: SessionRef | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const unsubs: Array<() => void> = [];
    // The link dropped (or never came up): nothing on screen can be acted on
    // any more — no stale card, no Waiting row, no Stop — until it is back.
    const lost = () => {
      if (!active || retry !== undefined) return;
      setLink("lost");
      setRef(undefined);
      setPending(null);
      setPhase("idle");
      setQueued([]);
      retry = setTimeout(() => setEpoch((n) => n + 1), reconnectDelay(attempts.current++));
    };
    unsubs.push(onLinkClosed(lost));
    openSession(sessionId)
      .then((opened) => {
        if (!active) {
          opened.release();
          return;
        }
        current = opened;
        attempts.current = 0;
        setRef(opened);
        setLink("live");
        unsubs.push(
          ...bindLoadedCells(opened, {
            transcript: setTranscript,
            queued: setQueued,
            conversationId: setConversationId,
            loaded: () => setLoaded(true),
          }),
        );
        unsubs.push(opened.phase.subscribe(setPhase));
        unsubs.push(opened.lastError.subscribe(setLastError));
        unsubs.push(opened.pending.subscribe(setPending));
        unsubs.push(opened.usage.subscribe(setUsage));
        unsubs.push(opened.model.subscribe(setModel));
        unsubs.push(opened.effort.subscribe(setEffort));
        unsubs.push(
          opened.onStatus((status) => {
            if (status === "gone") lost();
          }),
        );
      })
      .catch(lost);
    return () => {
      active = false;
      if (retry !== undefined) clearTimeout(retry);
      for (const unsub of unsubs) unsub();
      try {
        current?.release();
      } catch {
        // A ref on a dead link has nothing left to release.
      }
      setRef(undefined);
    };
  }, [sessionId, epoch]);

  // Every action resolves when the server accepted it and rejects otherwise —
  // the view decides how to surface the failure (nothing is swallowed here).
  const linked = useCallback((): SessionRef => {
    if (ref === undefined) throw new Error("Not connected");
    return ref;
  }, [ref]);

  const input = useCallback(
    async (text: string, whenBusy?: SendMode, attachments?: string[]): Promise<void> => {
      await linked().input({
        text,
        ...(whenBusy !== undefined ? { whenBusy } : {}),
        ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
      });
    },
    [linked],
  );

  const withdraw = useCallback(
    async (id: string): Promise<void> => {
      await linked().withdraw({ id });
    },
    [linked],
  );

  const retryQueued = useCallback(async (): Promise<void> => {
    await linked().retryQueued({});
  }, [linked]);

  const decide = useCallback(
    async (
      callId: string,
      approved: boolean,
      always?: boolean,
      takeover?: boolean,
      input?: unknown,
    ): Promise<{ stored: number | null }> => {
      const result = await linked().approve({
        callId,
        approved,
        ...(always === true ? { always: true } : {}),
        ...(takeover === true ? { takeover: true } : {}),
        ...(input !== undefined ? { input } : {}),
      });
      return { stored: result.stored?.length ?? null };
    },
    [linked],
  );

  const configure = useCallback(
    async (model: string | null, effort: ThinkingLevel | null): Promise<void> => {
      await linked().configure({ model, effort });
    },
    [linked],
  );

  const interrupt = useCallback(
    async (tasks?: boolean): Promise<void> => {
      await linked().interrupt(tasks === true ? { tasks: true } : {});
    },
    [linked],
  );

  return {
    link,
    loaded,
    transcript,
    phase,
    lastError,
    pending,
    usage,
    model,
    effort,
    conversationId,
    queued,
    input,
    withdraw,
    retryQueued,
    decide,
    configure,
    interrupt,
  };
}
