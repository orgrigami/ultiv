/**
 * Text overlap for the learning guard: whether a lesson copies a run of
 * words from outside content or a vault value, read as word runs and tokens.
 */

export const words = (text: string): string[] =>
  text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];

export const runsOf = (text: string, size: number): Set<string> => {
  const list = words(text);
  const runs = new Set<string>();
  for (let i = 0; i + size <= list.length; i += 1) runs.add(list.slice(i, i + size).join(" "));
  return runs;
};

export const sharesRun = (body: string, sources: readonly string[], size: number): boolean => {
  if (sources.length === 0) return false;
  const mine = runsOf(body, size);
  return sources.some((source) => [...runsOf(source, size)].some((run) => mine.has(run)));
};

/** Addresses, links, handles and long numbers: the parts a planted instruction needs. */
export const tokensOf = (text: string): Set<string> => {
  const found = new Set<string>();
  const patterns = [
    /[\w.+-]+@[\w-]+(\.[\w-]+)+/g,
    /\bhttps?:\/\/[^\s)>\]"']+/g,
    /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|id|dev|app|xyz|info|biz|me|ai|test)\b/g,
    /(?<!\w)@[a-z0-9_]{3,}/g,
    /\+?\d[\d ().-]{6,}\d/g,
  ];
  const lower = text.toLowerCase();
  for (const pattern of patterns) {
    for (const match of lower.match(pattern) ?? []) found.add(match.replace(/[\s().-]/g, ""));
  }
  return found;
};
