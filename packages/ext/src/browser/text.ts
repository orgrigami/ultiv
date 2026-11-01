/**
 * Page-text extraction for the browser tool (phase 4 slice 9) — pure string
 * work, no I/O: the rendered DOM chromium prints for `--dump-dom` is read
 * down to plain, capped text for the model. Page content is UNTRUSTED INPUT
 * (prompt injection): the caller presents it as data, never as instructions.
 */

/** Text cap for one page (same budget class as the bash tool's output). */
export const MAX_PAGE_TEXT_CHARS = 20_000;

/** The page's <title>, when the DOM carries one. */
export const pageTitleOf = (html: string): string | undefined => {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const text =
    match === null
      ? ""
      : decodeEntities(match[1] ?? "")
          .replace(/\s+/g, " ")
          .trim();
  return text === "" ? undefined : text.slice(0, 300);
};

/** Drop script/style bodies, turn block boundaries into line breaks. */
const stripMarkup = (html: string): string =>
  html
    .replace(/<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(
      /<\/?(?:p|div|br|hr|li|tr|td|th|h[1-6]|section|article|header|footer|nav|ul|ol|table|pre|blockquote|form|main|aside)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, " ");

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

const decodeEntities = (text: string): string =>
  text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });

/** Collapse runs of whitespace; drop the blank lines collapsing produces. */
const squeeze = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n");

/**
 * One page's visible text, capped. Returns the text plus whether the cap
 * cut it, so the tool can say so instead of silently truncating.
 */
export const pageTextOf = (
  html: string,
  cap: number = MAX_PAGE_TEXT_CHARS,
): { readonly text: string; readonly truncated: boolean } => {
  const text = squeeze(decodeEntities(stripMarkup(html)));
  if (text.length <= cap) return { text, truncated: false };
  return {
    text: `${text.slice(0, cap)}\n… [truncated ${text.length - cap} chars]`,
    truncated: true,
  };
};
