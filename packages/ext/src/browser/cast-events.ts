/**
 * The cast's wire words: what the broker's cast streams out (one JSON line
 * each) turned into typed events, and the acts the owner sends in. Frames
 * carry what maps a tap back onto the page (the frame id), where the page
 * stands, and whether a popup is on show. Events beyond frames — a page
 * dialog, a file chooser, a finished download — are never dropped.
 */

/** One screencast frame, everything the view needs to paint and map clicks. */
export interface CastFrame {
  readonly id: string;
  /** The image, base64 (a JPEG; PNG if chromium insists). */
  readonly data: string;
  readonly mime: "image/jpeg" | "image/png";
  readonly w: number;
  readonly h: number;
  readonly url: string;
  readonly title: string;
  /** The page on show is a popup the main tab opened. */
  readonly popup: boolean;
  readonly at: number;
}

/** One owner act, dispatched into the page as trusted input. */
export type CastAct =
  | {
      readonly a: "tap";
      readonly x: number;
      readonly y: number;
      readonly id: string;
      readonly count?: number;
    }
  | {
      readonly a: "down" | "up" | "hover";
      readonly x: number;
      readonly y: number;
      readonly id: string;
    }
  | {
      readonly a: "move";
      readonly x: number;
      readonly y: number;
      readonly id: string;
      readonly held: boolean;
    }
  | { readonly a: "type"; readonly text: string }
  | { readonly a: "key"; readonly key: string }
  | {
      readonly a: "scroll";
      readonly dx: number;
      readonly dy: number;
      readonly x?: number;
      readonly y?: number;
      readonly id?: string;
    }
  | { readonly a: "nav"; readonly url: string }
  | { readonly a: "reload" }
  | { readonly a: "back" }
  /** The page's selected text, sent back as `copied` (the owner's clipboard). */
  | { readonly a: "copy" }
  | { readonly a: "dialog"; readonly accept: boolean; readonly text?: string }
  | { readonly a: "upload"; readonly name: string; readonly data: string }
  | { readonly a: "viewport"; readonly w: number; readonly h: number; readonly mobile: boolean };

export type CastEvent =
  | { readonly kind: "ready" }
  | { readonly kind: "frame"; readonly frame: CastFrame }
  | { readonly kind: "page"; readonly popup: boolean; readonly url: string; readonly title: string }
  | {
      readonly kind: "dialog";
      readonly open: boolean;
      readonly type: string;
      readonly message: string;
      readonly default: string;
    }
  | { readonly kind: "chooser"; readonly open: boolean; readonly mode: string }
  /** The text the owner asked to copy out of the page. */
  | { readonly kind: "copied"; readonly text: string }
  /** A download finished and was saved to the bot's files. */
  | { readonly kind: "saved"; readonly id: string; readonly name: string }
  | { readonly kind: "error"; readonly error: string }
  | { readonly kind: "closed"; readonly reason: string };

const mimeOf = (data: string): "image/jpeg" | "image/png" =>
  data.startsWith("/9j/") ? "image/jpeg" : "image/png";

const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.slice(0, max) : "";

const frameOf = (parsed: Readonly<Record<string, unknown>>): CastFrame | undefined => {
  const data = typeof parsed.data === "string" ? parsed.data : "";
  const w = Number(parsed.w);
  const h = Number(parsed.h);
  if (data === "" || !Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) {
    return undefined;
  }
  return {
    id: text(parsed.id, 40),
    data,
    mime: mimeOf(data),
    w,
    h,
    url: text(parsed.url, 2_000),
    title: text(parsed.title, 300),
    popup: parsed.popup === true,
    at: Date.now(),
  };
};

/** A line the broker sent, read: an event, a download to take, a fatal, or nothing. */
export type CastLine =
  | { readonly kind: "event"; readonly event: CastEvent }
  | { readonly kind: "download"; readonly guid: string }
  | { readonly kind: "download-data"; readonly name: string; readonly data: string }
  | { readonly kind: "fatal"; readonly reason: string }
  | { readonly kind: "none" };

export const readCastLine = (line: string): CastLine => {
  let parsed: Readonly<Record<string, unknown>>;
  try {
    parsed = JSON.parse(line) as Readonly<Record<string, unknown>>;
  } catch {
    return { kind: "none" };
  }
  switch (parsed.t) {
    case "frame": {
      const frame = frameOf(parsed);
      return frame === undefined
        ? { kind: "none" }
        : { kind: "event", event: { kind: "frame", frame } };
    }
    case "ready":
      return { kind: "event", event: { kind: "ready" } };
    case "page":
      return {
        kind: "event",
        event: {
          kind: "page",
          popup: parsed.popup === true,
          url: text(parsed.url, 2_000),
          title: text(parsed.title, 300),
        },
      };
    case "dialog":
      return {
        kind: "event",
        event: {
          kind: "dialog",
          open: parsed.open === true,
          type: text(parsed.type, 20) || "alert",
          message: text(parsed.message, 1_000),
          default: text(parsed.default, 200),
        },
      };
    case "chooser":
      return {
        kind: "event",
        event: {
          kind: "chooser",
          open: parsed.open === true,
          mode: text(parsed.mode, 30) || "selectSingle",
        },
      };
    case "copied":
      return { kind: "event", event: { kind: "copied", text: text(parsed.text, 20_000) } };
    case "download":
      return typeof parsed.guid === "string"
        ? { kind: "download", guid: parsed.guid }
        : { kind: "none" };
    case "download-data":
      return {
        kind: "download-data",
        name: text(parsed.name, 200),
        data: text(parsed.data, 40_000_000),
      };
    case "error":
      return {
        kind: "event",
        event: { kind: "error", error: text(parsed.error, 300) || "the act failed" },
      };
    case "closed":
      return { kind: "fatal", reason: text(parsed.reason, 300) || "the browser closed" };
    case "fatal":
      return { kind: "fatal", reason: text(parsed.error, 300) || "the cast could not start" };
    default:
      return { kind: "none" };
  }
};
