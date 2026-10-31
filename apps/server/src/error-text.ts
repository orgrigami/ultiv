/**
 * The owner-facing error sentence lives in @spriessen/core so the mind (task
 * errors) and the server (turn banners) say the same thing; re-exported here
 * for the server's existing imports.
 */
export { ownerErrorText, scrubSecrets } from "@spriessen/mind";
