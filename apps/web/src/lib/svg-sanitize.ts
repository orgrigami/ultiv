/**
 * A diagram's SVG made safe to inline. Pele draws from text the bot wrote, and
 * the bot reads untrusted pages, so the markup is treated as hostile: an
 * allowlist of drawing elements (anything else is dropped with its content),
 * no event handlers, links only to ids in the same SVG, and styles that can't
 * load anything. Pure string work, so it runs (and is tested) without a DOM.
 */

const ALLOWED = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "title",
  "desc",
  "defs",
  "marker",
  "clippath",
  "lineargradient",
  "radialgradient",
  "stop",
  "pattern",
  "mask",
  "symbol",
  "use",
]);

/** Element names that never close (or may self-close) don't nest a skip. */
const TAG =
  /^<(\/?)([a-zA-Z][\w:.-]*)((?:\s+[^\s=>/"']+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/;
const ATTR = /([^\s=>/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Entities decoded, so `&#106;avascript:` reads as what it is. */
const decode = (value: string): string =>
  value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (whole, ref: string) => {
    if (ref[0] !== "#") return NAMED[ref.toLowerCase()] ?? whole;
    const code =
      ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
  });

const escapeAttr = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/** Every url(…) in a value points inside this SVG (`url(#id)`). */
const localUrlsOnly = (squashed: string): boolean => {
  for (const match of squashed.matchAll(/url\(([^)]*)\)?/g)) {
    const target = (match[1] ?? "").replace(/^["']/, "");
    if (!target.startsWith("#")) return false;
  }
  return true;
};

/** An attribute's value kept as is, or null to drop the attribute. */
function keptValue(name: string, raw: string): string | null {
  const value = decode(raw);
  // Spaces and control characters out, so `java\tscript:` reads as one word.
  const squashed = [...value.toLowerCase()].filter((char) => char > " ").join("");
  if (name.startsWith("on")) return null;
  if (name === "href" || name === "xlink:href" || name === "src" || name === "action") {
    return squashed.startsWith("#") ? value : null;
  }
  if (/javascript:|vbscript:|data:|expression\(|@import|behavior:|-moz-binding|\\/.test(squashed)) {
    return null;
  }
  if (!localUrlsOnly(squashed)) return null;
  return value;
}

function cleanAttrs(attrs: string): string {
  let out = "";
  for (const match of attrs.matchAll(ATTR)) {
    const name = (match[1] ?? "").toLowerCase();
    if (name === "") continue;
    const raw = match[2] ?? match[3] ?? match[4] ?? "";
    const kept = keptValue(name, raw);
    if (kept !== null) out += ` ${match[1]}="${escapeAttr(kept)}"`;
  }
  return out;
}

/** Skips a dropped element and everything inside it; returns where it ends. */
function skipElement(svg: string, from: number, name: string): number {
  let depth = 1;
  let at = from;
  while (depth > 0) {
    const next = svg.indexOf("<", at);
    if (next === -1) return svg.length;
    const tag = TAG.exec(svg.slice(next));
    if (tag === null) {
      at = next + 1;
      continue;
    }
    at = next + tag[0].length;
    if ((tag[2] ?? "").toLowerCase() !== name || tag[4] === "/") continue;
    depth += tag[1] === "/" ? -1 : 1;
  }
  return at;
}

/** Markup with no tag in it: comments, CDATA, doctypes and PIs disappear. */
const SKIPPED = [
  ["<!--", "-->"],
  ["<![CDATA[", "]]>"],
  ["<!", ">"],
  ["<?", "?>"],
] as const;

/** The SVG with everything outside the drawing allowlist removed. */
export function sanitizeSvg(svg: string): string {
  let out = "";
  let at = 0;
  while (at < svg.length) {
    const next = svg.indexOf("<", at);
    if (next === -1) {
      out += svg.slice(at).replace(/>/g, "&gt;");
      break;
    }
    out += svg.slice(at, next).replace(/>/g, "&gt;");
    const skipped = SKIPPED.find(([open]) => svg.startsWith(open, next));
    if (skipped !== undefined) {
      const end = svg.indexOf(skipped[1], next + skipped[0].length);
      at = end === -1 ? svg.length : end + skipped[1].length;
      continue;
    }
    const tag = TAG.exec(svg.slice(next));
    if (tag === null) {
      out += "&lt;";
      at = next + 1;
      continue;
    }
    at = next + tag[0].length;
    const [, closing, rawName = "", attrs = "", self] = tag;
    const name = rawName.toLowerCase();
    if (!ALLOWED.has(name)) {
      if (closing !== "/" && self !== "/") at = skipElement(svg, at, name);
      continue;
    }
    out +=
      closing === "/"
        ? `</${rawName}>`
        : `<${rawName}${cleanAttrs(attrs)}${self === "/" ? "/" : ""}>`;
  }
  return out;
}
