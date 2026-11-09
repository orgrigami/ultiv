/**
 * The bot's side of a browser takeover: `browser_session` op "takeover".
 * The call registers the ask and BLOCKS until it closes — the owner drives
 * the live view meanwhile — then answers with how it closed: the page as it
 * stands when they Finish, a plain note otherwise. The asking turn's abort
 * (the owner stopped the turn, the task was killed) closes the ask too, so a
 * dead turn never leaves the owner a takeover nobody is waiting on, or the
 * hold standing over a browser no one will use.
 */
import type {
  TakeoverOutcome,
  TakeoverRegistry,
  TakeoverAct,
  TakeoverState,
} from "../browser/takeover.ts";

type PageReply = {
  readonly url?: string;
  readonly title?: string;
};

export interface TakeoverCallDeps {
  readonly takeovers: TakeoverRegistry;
  readonly act: (act: TakeoverAct) => Promise<TakeoverState>;
  /** Read the page as it stands (after a finish). */
  readonly read: () => Promise<PageReply>;
  /** The model-facing text of a read. */
  readonly pageText: (reply: PageReply) => string;
}

const NOTES: Record<Exclude<TakeoverOutcome, "finished">, string> = {
  replaced:
    "a newer takeover ask on this session replaced yours; this call stands down. " +
    "Wait for that one's result.",
  "timed-out":
    "your owner did not take the controls within the takeover's window, so the ask " +
    "closed and the hold lifted. The page stands where you left it (op read); ask " +
    "again (op takeover) once your owner is around, or work without signing in.",
  "stepped-away":
    "your owner stepped away without finishing; the takeover closed and the hold " +
    "lifted. Read the page (op read) to see where it stands, then decide your next " +
    "step.",
};

/** The asking turn's abort signal (chord's Context; tests pass none). */
export const signalOf = (context: unknown): AbortSignal | undefined => {
  const signal = (context as { readonly abortSignal?: unknown } | undefined)?.abortSignal;
  return signal instanceof AbortSignal ? signal : undefined;
};

const text = (value: string) => [{ type: "text" as const, text: value }];

export const takeoverCall = async (
  deps: TakeoverCallDeps,
  conversationId: string,
  reason: string,
  signal: AbortSignal | undefined,
) => {
  const row = await deps.takeovers.open({ conversationId, reason, act: deps.act });
  // A turn stopped while the owner drives closes the ask as a step-away.
  const onAbort = (): void => void deps.takeovers.cancel(row.id);
  if (signal?.aborted === true) onAbort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let outcome: TakeoverOutcome;
  try {
    outcome = await deps.takeovers.wait(row.id);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  if (outcome !== "finished") {
    return {
      output: text(NOTES[outcome]),
      structuredOutput: { ok: true, takeover: row.id, outcome },
    };
  }
  let page: PageReply;
  try {
    page = await deps.read();
  } catch (cause) {
    return {
      output: text(
        `your owner finished, but the page could not be read back: ${String(cause).slice(0, 200)}`,
      ),
      isError: true as const,
    };
  }
  return {
    output: text(
      `your owner took the controls (${row.reason}) and has finished. The page now ` +
        `stands:\n\n${deps.pageText(page)}`,
    ),
    structuredOutput: {
      ok: true,
      takeover: row.id,
      outcome,
      ...(page.url !== undefined ? { url: page.url } : {}),
      ...(page.title !== undefined ? { title: page.title } : {}),
    },
  };
};
