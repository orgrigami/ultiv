/**
 * Model lanes: which requests are the owner's chats and which are background
 * work, so the gate (gate.ts) can serve the owner first and keep one slot
 * for them while tasks run.
 *
 * The gate only sees `streamSimple(model, context, options)`, so the lane is
 * recorded just before the request: a `beforeRequest` hook knows the
 * conversation, and marks the two things the request's options will carry —
 * the run's abort signal (`options.signal`, the same object the hook's api
 * holds as `signal` at runtime) and the conversation's provider session id
 * (`options.sessionId`, from pi-durable's `ProviderDoc`). The signal covers a
 * conversation's very first request, before its provider id exists; the
 * session id covers the rest even if the signal is not exposed. Anything
 * unmarked (titles, compaction, embeddings) rides the owner lane, as before.
 */
import { GenerationTask, ProviderDoc, defineExtension, hook } from "@earendil-works/pi-durable";

export type Lane = "owner" | "background";

export interface ModelLanes {
  /** Record the lane of the request about to go out on this signal and session. */
  readonly mark: (
    signal: AbortSignal | undefined,
    sessionId: string | undefined,
    lane: Lane,
  ) => void;
  /** The lane of a request, read from its stream options. */
  readonly laneOf: (options: unknown) => Lane;
}

/** Provider session ids remembered at once; the oldest are forgotten first. */
const SESSION_MEMORY = 4_000;

export const modelLanes = (): ModelLanes => {
  const bySignal = new WeakMap<AbortSignal, Lane>();
  const bySession = new Map<string, Lane>();
  return {
    mark: (signal, sessionId, lane) => {
      if (signal !== undefined) bySignal.set(signal, lane);
      if (sessionId === undefined) return;
      bySession.delete(sessionId);
      bySession.set(sessionId, lane);
      if (bySession.size > SESSION_MEMORY) {
        const oldest = bySession.keys().next().value;
        if (oldest !== undefined) bySession.delete(oldest);
      }
    },
    laneOf: (options) => {
      if (typeof options !== "object" || options === null) return "owner";
      const { signal, sessionId } = options as { signal?: unknown; sessionId?: unknown };
      const bySig = signal instanceof AbortSignal ? bySignal.get(signal) : undefined;
      if (bySig !== undefined) return bySig;
      return (typeof sessionId === "string" ? bySession.get(sessionId) : undefined) ?? "owner";
    },
  };
};

/** The registry extension that marks every model request with its conversation's lane. */
export const lanesExtension = (
  lanes: ModelLanes,
  laneOfConversation: (conversationId: string) => Lane | Promise<Lane>,
) =>
  defineExtension({
    name: "ultius.mind.model-lanes",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (_request, api, context) => {
          const lane = await Promise.resolve(laneOfConversation(String(api.conversationId))).catch(
            (): Lane => "owner",
          );
          // At runtime the hook's api is the task runtime, whose signal the
          // request's options carry; it is not part of the typed HookApi.
          const signal = (api as { readonly signal?: unknown }).signal;
          const provider = await api
            .snapshot(ProviderDoc, api.conversationId, context)
            .catch(() => undefined);
          lanes.mark(signal instanceof AbortSignal ? signal : undefined, provider?.sessionId, lane);
          return undefined;
        },
      }),
    ],
  });
