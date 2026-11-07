/**
 * How line commands print: plain lines on stdout (`--json` for machines),
 * a little colour when stdout is a terminal (never into a pipe, never with
 * `NO_COLOR`; `FORCE_COLOR=1` forces it), and the few shared formats every
 * list uses — short ids, ages, a "when" for a timestamp.
 */
import { boolFlag, type Parsed } from "../args.ts";

const colourOn = (stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean => {
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return false;
  if (env["FORCE_COLOR"] !== undefined && env["FORCE_COLOR"] !== "0") return true;
  return stream.isTTY === true && env["TERM"] !== "dumb";
};

const wrap =
  (open: number, close: number, on: () => boolean) =>
  (text: string): string =>
    on() ? `\u001b[${open}m${text}\u001b[${close}m` : text;

export interface Paint {
  readonly on: boolean;
  readonly bold: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly red: (text: string) => string;
  readonly green: (text: string) => string;
  readonly amber: (text: string) => string;
  readonly blue: (text: string) => string;
}

/** Colours for one stream (stdout by default). */
export const paintFor = (stream: { isTTY?: boolean } = process.stdout): Paint => {
  const on = colourOn(stream);
  const when = () => on;
  return {
    on,
    bold: wrap(1, 22, when),
    dim: wrap(2, 22, when),
    red: wrap(31, 39, when),
    green: wrap(32, 39, when),
    amber: wrap(33, 39, when),
    blue: wrap(34, 39, when),
  };
};

/** `--json` prints the value; otherwise the lines. */
export const print = (parsed: Parsed, value: unknown, lines: () => readonly string[]): void => {
  if (boolFlag(parsed, "json")) console.log(JSON.stringify(value, null, 2));
  else for (const line of lines()) console.log(line);
};

/** The id prefix lists show and every id-taking command accepts (a main chat's `main-` is not counted). */
export const shortId = (id: string): string =>
  id.startsWith("main-") ? id.slice(0, 13) : id.slice(0, 8);

/** "now", "5m ago", "3h ago", "2d ago", then the date. */
export const ago = (at: number, now = Date.now()): string => {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`;
  return new Date(at).toISOString().slice(0, 10);
};

/** A local "YYYY-MM-DD HH:MM". */
export const when = (at: number): string => {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** Cut to `width` characters on one line, with an ellipsis. */
export const clip = (text: string, width: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= width ? flat : `${flat.slice(0, Math.max(0, width - 1))}…`;
};

/** "1 chat", "3 chats". */
export const count = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;
