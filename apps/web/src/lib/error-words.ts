/**
 * Plain words for failures that arrive without a server sentence: an HTTP
 * status with no JSON `error`, or the browser's own network error (which
 * differs per engine). The method and path stay out of the owner's view.
 */

/** A status with no server reason, as a sentence. */
export function statusText(status: number): string {
  if (status === 401) return "You're signed out. Sign in again to continue.";
  if (status === 403) return "That isn't allowed.";
  if (status === 404) return "That's no longer here.";
  if (status === 413) return "That's too large to send.";
  if (status === 429) return "Too many requests. Wait a moment and try again.";
  if (status === 502 || status === 503 || status === 504)
    return "The server isn't answering right now. Try again in a moment.";
  if (status >= 500) return "The server hit an error. Try again in a moment.";
  return `The request failed (${status}).`;
}

/** Chrome, Firefox and Safari word a failed fetch differently. */
const NETWORK =
  /^(Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed|Network request failed)$/i;

/** The browser's network error in plain words; anything else unchanged. */
export const networkText = (message: string): string =>
  NETWORK.test(message.trim())
    ? "Can't reach the server. Check your connection and try again."
    : message;
