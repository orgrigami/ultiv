/**
 * What a failed command tells the owner: one or two plain sentences and,
 * where there is one, the command that fixes it — never a stack trace. The
 * usual failures get their own words: not signed in, the server not
 * answering (refused, unknown host, timed out), a wrong passcode, too many
 * attempts. `SPRIESSEN_DEBUG=1` prints the full error underneath, for when
 * the sentence is not enough.
 */
import { ApiError, SignInRequired } from "./client/http.ts";

const CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ECONNRESET",
]);

/** The network error code under fetch's "fetch failed" (or a ws error), if any. */
const connectCodeOf = (cause: unknown): string | undefined => {
  let current: unknown = cause;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && CONNECT_CODES.has(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
};

export const unreachable = (server: string): string =>
  `Can't reach the server at ${server}.\n` +
  "Is it running? Start one here with `spriessen serve`, or pick another with --server <url>.";

/** The sentence(s) for a failure, given the server the command talked to. */
export const sentenceOf = (cause: unknown, server: string): string => {
  if (cause instanceof SignInRequired) {
    return `You're not signed in to ${server}.\nRun \`spriessen login\` first.`;
  }
  // fetch says "fetch failed" for every network-level failure (refused,
  // DNS, TLS, a blocked port); the code underneath only refines it.
  const fetchFailed = cause instanceof TypeError && cause.message === "fetch failed";
  if (fetchFailed || connectCodeOf(cause) !== undefined) return unreachable(server);
  if (cause instanceof ApiError) {
    if (cause.path === "/api/auth/sign-in" && cause.status === 401) {
      return "That passcode didn't work. Try `spriessen login` again.";
    }
    if (cause.status === 429) return `${capitalize(cause.detail)}.`;
    if (cause.status >= 500) {
      return "The server ran into a problem with that. Its log has the details; try again in a moment.";
    }
    return `${capitalize(cause.detail)}.`;
  }
  if (cause instanceof Error)
    return `${capitalize(cause.message)}${/[.!?]$/.test(cause.message) ? "" : "."}`;
  return "Something went wrong.";
};

const capitalize = (text: string): string =>
  text === "" ? text : text[0]?.toUpperCase() + text.slice(1);

/** Print a failure for the owner (and the full error with SPRIESSEN_DEBUG=1). */
export const report = (cause: unknown, server: string): void => {
  console.error(sentenceOf(cause, server));
  if (process.env["SPRIESSEN_DEBUG"] === "1") console.error("\n", cause);
};
