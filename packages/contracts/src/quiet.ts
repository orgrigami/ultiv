/**
 * "Nothing to report": the whole reply a bot gives a routine wake (a cron
 * run, a webhook, a sensor, a background routine task) when nothing changed
 * that its owner needs to see or act on. The server sends no push for it,
 * and both clients show it as one quiet line instead of a reply. Every
 * message costs the owner attention; a quiet check-in costs none.
 */
export const NOTHING_TO_REPORT = "[nothing to report]";

/** The owner-facing words for a quiet check-in. */
export const NOTHING_TO_REPORT_WORDS = "Checked in: nothing to report";

/**
 * True when a reply is the quiet marker, tolerating what models add around
 * it: case, surrounding whitespace, backticks and a trailing full stop.
 */
export const isNothingToReport = (text: string | null | undefined): boolean => {
  if (typeof text !== "string") return false;
  const bare = text
    .trim()
    .replace(/^`+|`+$/g, "")
    .trim()
    .replace(/[.!]+$/, "")
    .toLowerCase();
  return bare === NOTHING_TO_REPORT;
};
