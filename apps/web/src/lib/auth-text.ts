/**
 * The words the sign-in screens show: a refused auth call as one sentence,
 * a passkey prompt's failure, and a sign-in audit row in plain language.
 * Pure, so the wording is tested without a browser.
 */

/** "Try again in 3 min" from a retry-after in seconds. */
const waitText = (seconds: number): string =>
  seconds < 60 ? `${Math.max(1, seconds)} s` : `${Math.ceil(seconds / 60)} min`;

/**
 * The one line the user reads for a refused auth call: the server's own
 * reason as a sentence, a throttle as a wait, and a plain fallback.
 */
export const authErrorText = (
  status: number,
  error: string | undefined,
  retryAfter: string | null,
): string => {
  if (status === 429) {
    const seconds = Number(retryAfter);
    return Number.isFinite(seconds) && seconds > 0
      ? `Too many attempts. Try again in ${waitText(seconds)}.`
      : "Too many attempts. Try again in a moment.";
  }
  if (error === undefined || error.trim() === "") return "That didn't work. Try again.";
  const text = error.trim();
  const sentence = text.charAt(0).toUpperCase("en") + text.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
};

/** What the browser's passkey prompt threw, in words. */
export const passkeyErrorText = (cause: unknown): string => {
  const name = cause instanceof Error ? cause.name : "";
  if (name === "NotAllowedError" || name === "AbortError") {
    return "The passkey prompt was closed or timed out.";
  }
  if (name === "InvalidStateError") return "This device already has a passkey here.";
  if (name === "SecurityError" || name === "NotSupportedError") {
    return "Passkeys need HTTPS or localhost on this browser.";
  }
  return cause instanceof Error && cause.message !== "" ? cause.message : "That didn't work.";
};

const EVENT_TEXT: Record<string, string> = {
  "sign-in": "Signed in",
  "sign-out": "Signed out",
  "passcode-set": "Passcode set",
  "passcode-change": "Passcode changed",
  "passkey-added": "Passkey added",
  "passkey-removed": "Passkey removed",
  recovery: "Passcode reset from the server",
};

const FAILED_TEXT: Record<string, string> = {
  "sign-in": "Sign-in refused",
  "passcode-set": "Passcode not set",
  "passcode-change": "Passcode change refused",
};

const REASON_TEXT: Record<string, string> = {
  "wrong passcode": "wrong passcode",
  "refused: throttled": "too many attempts",
  "refused: not the host": "not from the server's own machine",
  "passkey not verified": "passkey not recognised",
};

/** One sign-in audit row as a line a person reads ("Sign-in refused: wrong passcode"). */
export const authEventText = (
  rawName: string | null,
  ok: boolean | null,
  error?: string | null,
): string => {
  const name = rawName ?? "sign-in event";
  if (ok !== false) return EVENT_TEXT[name] ?? name;
  const what = FAILED_TEXT[name] ?? `${EVENT_TEXT[name] ?? name} refused`;
  const why = error === undefined || error === null ? undefined : (REASON_TEXT[error] ?? error);
  return why === undefined ? what : `${what}: ${why}`;
};
