/**
 * The owner-facing error sentence lives in @spreissen/core so the mind (task
 * errors) and the server (turn banners) say the same thing; re-exported here
 * for the server's existing imports.
 */
export { ownerErrorText, scrubSecrets } from "@spreissen/mind";
