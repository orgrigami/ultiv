/**
 * Pure helpers for the message search on Past chats: who said a hit, and
 * the snippet split into plain and highlighted parts (a query word
 * matches at the start of a word in any letter case, accents folded).
 */
import type { HistoryHit } from "@spriessen/contracts";

export const MIN_QUERY = 2;

/** "You", the bot's name, or "Tool result". */
export function speakerOf(hit: Pick<HistoryHit, "role">, botName: string): string {
  if (hit.role === "user") return "You";
  if (hit.role === "tool") return "Tool result";
  return botName;
}

const fold = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

export type Part = { readonly text: string; readonly hit: boolean };

/** Split `text` around the query words (3+ letters) it contains. */
export function highlightParts(text: string, query: string): Part[] {
  const words = [...new Set(fold(query).split(/[^\p{L}\p{N}]+/u))].filter(
    (word) => word.length >= 3,
  );
  if (words.length === 0) return [{ text, hit: false }];
  const folded = fold(text);
  // NFKD can change lengths; highlighting is cosmetic, so fall back to plain.
  if (folded.length !== text.length) return [{ text, hit: false }];
  const marks: boolean[] = Array.from({ length: text.length }, () => false);
  for (const word of words) {
    let from = 0;
    for (;;) {
      const at = folded.indexOf(word, from);
      if (at < 0) break;
      const startsWord = at === 0 || !/[\p{L}\p{N}]/u.test(folded[at - 1] ?? "");
      if (startsWord) for (let i = at; i < at + word.length; i += 1) marks[i] = true;
      from = at + 1;
    }
  }
  const parts: Part[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const hit = marks[i] === true;
    const last = parts[parts.length - 1];
    if (last !== undefined && last.hit === hit)
      parts[parts.length - 1] = { text: last.text + text[i], hit };
    else parts.push({ text: text[i] ?? "", hit });
  }
  return parts;
}
