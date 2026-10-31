/**
 * Mermaid text to a safe, themed SVG in the browser. Pele (and only the one
 * diagram family the text needs) loads on first use, measures text with the
 * app's own font, and its output passes the sanitizer before it is inlined.
 * Colours come from the `--pele-*` variables in index.css, so a drawing
 * follows light and dark without redrawing.
 */
import { GRAPH_MAX_SOURCE } from "@spriessen/contracts";
import { sanitizeSvg } from "./svg-sanitize.ts";

export type Drawn =
  | { readonly ok: true; readonly svg: string; readonly type: string }
  | { readonly ok: false; readonly message: string };

type PeleFailure = { code?: unknown; line?: unknown; column?: unknown; message?: unknown };

/** Why a drawing failed, in a sentence the owner can read. */
export function diagramErrorText(error: unknown): string {
  const failure = (typeof error === "object" && error !== null ? error : {}) as PeleFailure;
  const message = typeof failure.message === "string" ? failure.message : String(error);
  switch (failure.code) {
    case "unsupported-diagram":
      return "Not a diagram type this app draws.";
    case "syntax":
      return `Syntax error at line ${String(failure.line)}, column ${String(failure.column)}: ${message}`;
    case "limit":
      return "Too large to draw.";
    default:
      return message === "" ? "Couldn't draw this diagram." : message;
  }
}

/** Ids unique per drawing, so two diagrams on one page never share a marker. */
export async function drawDiagram(source: string, idPrefix: string): Promise<Drawn> {
  if (source.trim() === "") return { ok: false, message: "The diagram is empty." };
  if (source.length > GRAPH_MAX_SOURCE) return { ok: false, message: "Too large to draw." };
  try {
    const { renderAsync } = await import("pele/lazy");
    const drawn = await renderAsync(source, {
      links: false,
      images: false,
      limit: GRAPH_MAX_SOURCE,
      idPrefix,
      fontFamily: "Geist Variable, sans-serif",
      fontFamilyMono: "Geist Mono Variable, monospace",
    });
    return { ok: true, svg: sanitizeSvg(drawn.svg), type: drawn.type };
  } catch (error) {
    return { ok: false, message: diagramErrorText(error) };
  }
}
