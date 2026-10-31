import { useCallback, useEffect, useState } from "react";
import type {
  PendingApproval,
  Phase,
  QueuedInput,
  ThinkingLevel,
  TranscriptEntry,
  UsageSummary,
  SendMode,
} from "@spreissen/contracts";
import { openSession, type SessionRef } from "./chord.ts";

export type LinkPhase = "connecting" | "live" | "lost";

export function useSession(sessionId: string): {
  link: LinkPhase;
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
  const [ref, setRef] = useState<SessionRef | undefined>(undefined);

  useEffect(() => {
    let active = true;
    let current: SessionRef | undefined;
    const unsubs: Array<() => void> = [];
    openSession(sessionId)
      .then((opened) => {
        if (!active) {
          opened.release();
          return;
        }
        current = opened;
        setRef(opened);
        setLink("live");
        unsubs.push(opened.transcript.subscribe(setTranscript));
        unsubs.push(opened.phase.subscribe(setPhase));
        unsubs.push(opened.lastError.subscribe(setLastError));
        unsubs.push(opened.pending.subscribe(setPending));
        unsubs.push(opened.usage.subscribe(setUsage));
        unsubs.push(opened.model.subscribe(setModel));
        unsubs.push(opened.effort.subscribe(setEffort));
        unsubs.push(opened.conversationId.subscribe(setConversationId));
        unsubs.push(opened.queued.subscribe(setQueued));
        unsubs.push(
          opened.onStatus((status) => {
            if (status === "gone") setLink("lost");
          }),
        );
      })
      .catch(() => {
        if (active) setLink("lost");
      });
    return () => {
      active = false;
      for (const unsub of unsubs) unsub();
      current?.release();
      setRef(undefined);
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
    };
  }, [sessionId]);

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
    decide,
    configure,
    interrupt,
  };
}
