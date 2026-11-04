/**
 * Text → FTS5: the bridge between our bilingual analysis (memory/text.ts)
 * and SQLite's tokenizers. Terms are written pre-analyzed, so FTS5 only has
 * to split on spaces; synonym concepts (`§cat`) become plain alphanumeric
 * tokens (`zccat`) that `unicode61` keeps whole. Queries are built from the
 * same analysis and always quoted, so no user text is ever FTS5 syntax.
 */
import { analyze, normalize } from "../memory/text.ts";

const CONCEPT_PREFIX = "zc";

/** A §concept as an FTS-safe token. */
export const conceptWord = (concept: string): string =>
  `${CONCEPT_PREFIX}${concept.replace(/^§/, "").replace(/[^a-z0-9]/g, "")}`;

/** One text as the two term columns: surface stems and concept tokens. */
export const termsOf = (text: string): { readonly terms: string; readonly concepts: string } => {
  const terms = new Set<string>();
  const concepts = new Set<string>();
  for (const token of analyze(text)) {
    terms.add(token.term);
    if (token.concept !== null) concepts.add(conceptWord(token.concept));
  }
  return { terms: [...terms].join(" "), concepts: [...concepts].join(" ") };
};

const quote = (token: string): string => `"${token.replace(/"/g, '""')}"`;

/**
 * The BM25 query: every analyzed term and concept OR'ed, each quoted (a
 * bigram concept phrase stays a phrase). Null when nothing is searchable
 * (only stop words, punctuation).
 */
export const termsQuery = (query: string): string | null => {
  const parts = new Set<string>();
  for (const token of analyze(query)) {
    parts.add(quote(token.term));
    if (token.concept !== null) parts.add(quote(conceptWord(token.concept)));
  }
  return parts.size === 0 ? null : [...parts].join(" OR ");
};

/**
 * The trigram query: each query word of 4+ letters as its letter triples,
 * OR'ed — a word typed with a slip still shares most of its triples with
 * the stored one, and a code or a name fragment matches inside a word.
 */
export const gramsQuery = (query: string): string | null => {
  const grams = new Set<string>();
  for (const word of normalize(query).split(/[^\p{L}\p{N}@._-]+/u)) {
    if ([...word].length < 4) continue;
    const letters = [...word];
    for (let i = 0; i + 3 <= letters.length; i += 1) grams.add(letters.slice(i, i + 3).join(""));
  }
  return grams.size === 0 ? null : [...grams].map(quote).join(" OR ");
};

/** A short excerpt of `text` around its first query word, for result rows. */
export const snippetOf = (text: string, query: string, span = 160): string => {
  const words = normalize(query)
    .split(/\s+/)
    .filter((word) => word.length >= 3);
  const haystack = normalize(text);
  let at = -1;
  for (const word of words) {
    at = haystack.indexOf(word);
    if (at >= 0) break;
  }
  if (at < 0 || text.length <= span) return text.slice(0, span) + (text.length > span ? "…" : "");
  const start = Math.max(0, at - Math.floor(span / 3));
  const end = Math.min(text.length, start + span);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
};
