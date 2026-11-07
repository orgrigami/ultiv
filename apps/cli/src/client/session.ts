/**
 * The chord half of the terminal client: one client host linked upstream to
 * the server's chord endpoint over `ws`, signed in with the session cookie on
 * the upgrade (the server's upgrade gate is the same one the browser
 * passes). `watchSession` folds a Session object's cells into ONE snapshot
 * and calls back on every change, holding the transcript back until the
 * server has loaded the conversation (`conversationId` set) — the same rule
 * the web's `bindLoadedCells` keeps, so an open never flashes an empty chat.
 */
import {
  createHost,
  webSocketLink,
  type Host,
  type Ref,
  type WebSocketLike,
} from "@earendil-works/chord";
import {
  Session,
  type ThinkingLevel,
  type PendingApproval,
  type Phase,
  type QueuedInput,
  type TranscriptEntry,
  type UsageSummary,
} from "@spriessen/contracts";
import WebSocket from "ws";

export type SessionRef = Ref<typeof Session>;
type Principal = { kind: "guest" };

export interface Link {
  readonly open: (sessionId: string) => Promise<SessionRef>;
  /** Called once when the link drops (server restart, network). */
  readonly onClosed: (listener: () => void) => () => void;
  readonly close: () => void;
}

/** `http(s)://host` → `ws(s)://host/chord`. */
export const chordUrlOf = (server: string): string =>
  `${server.replace(/^http:/, "ws:").replace(/^https:/, "wss:")}/chord`;

export const connectLink = async (server: string, cookie: string): Promise<Link> => {
  const host: Host<Principal> = createHost<Principal>({
    name: "cli",
    self: { kind: "guest" },
    kind: "client",
  });
  const socket = new WebSocket(chordUrlOf(server), { headers: { cookie } });
  // Link FIRST, then wait for open: `ws` can emit the server's hello in the
  // same tick as `open`, and a hello nobody heard makes chord refuse the
  // server's first ack as a protocol violation (the link then closes). The
  // link queues its own frames until the socket opens.
  host.connect(webSocketLink(socket as unknown as WebSocketLike), {
    principal: { kind: "guest" },
  });
  const listeners = new Set<() => void>();
  socket.on("close", () => {
    for (const listener of listeners) listener();
    listeners.clear();
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("unexpected-response", (_req, res) =>
      reject(
        new Error(
          res.statusCode === 401
            ? "sign in first: run `spriessen login`"
            : `the server refused the link (${res.statusCode})`,
        ),
      ),
    );
    socket.once("error", (cause) => reject(cause));
  });
  return {
    open: (sessionId) => host.get(Session, { id: sessionId }),
    onClosed: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => socket.close(),
  };
};

/** Everything one chat shows, as one value. */
export interface SessionSnapshot {
  readonly loaded: boolean;
  readonly transcript: readonly TranscriptEntry[];
  readonly phase: Phase;
  readonly lastError: string | null;
  readonly pending: PendingApproval;
  readonly usage: UsageSummary | null;
  readonly model: string | null;
  readonly effort: ThinkingLevel | null;
  readonly conversationId: string | null;
  readonly queued: readonly QueuedInput[];
}

export const EMPTY_SNAPSHOT: SessionSnapshot = {
  loaded: false,
  transcript: [],
  phase: "idle",
  lastError: null,
  pending: null,
  usage: null,
  model: null,
  effort: null,
  conversationId: null,
  queued: [],
};

/** Subscribe to a Session ref; answers the unsubscribe. */
export const watchSession = (
  ref: SessionRef,
  onChange: (snapshot: SessionSnapshot) => void,
): (() => void) => {
  let snapshot = EMPTY_SNAPSHOT;
  const held: { transcript?: readonly TranscriptEntry[]; queued?: readonly QueuedInput[] } = {};
  const set = (patch: Partial<SessionSnapshot>): void => {
    snapshot = { ...snapshot, ...patch };
    onChange(snapshot);
  };
  const unsubs = [
    ref.transcript.subscribe((value) => {
      if (snapshot.loaded) set({ transcript: value });
      else held.transcript = value;
    }),
    ref.queued.subscribe((value) => {
      if (snapshot.loaded) set({ queued: value });
      else held.queued = value;
    }),
    ref.conversationId.subscribe((value) => {
      if (value === null) return;
      if (snapshot.loaded) return set({ conversationId: value });
      set({
        conversationId: value,
        loaded: true,
        transcript: held.transcript ?? [],
        queued: held.queued ?? [],
      });
    }),
    ref.phase.subscribe((phase) => set({ phase })),
    ref.lastError.subscribe((lastError) => set({ lastError })),
    ref.pending.subscribe((pending) => set({ pending })),
    ref.usage.subscribe((usage) => set({ usage })),
    ref.model.subscribe((model) => set({ model })),
    ref.effort.subscribe((effort) => set({ effort })),
  ];
  return () => {
    for (const unsub of unsubs) unsub();
  };
};
