/**
 * Slash commands typed into the composer: the chat's message actions the
 * web puts on buttons. Pure parsing and transcript lookups here; the TUI
 * runs them (use-slash.ts). `//text` sends "/text" as a message.
 */
import type { TranscriptEntry } from "@spriessen/contracts";
import { machineryLine } from "../render/words.ts";

export type Slash =
  | { readonly kind: "help" }
  | { readonly kind: "new" }
  | { readonly kind: "stop" }
  | { readonly kind: "bot"; readonly name: string }
  | { readonly kind: "edit"; readonly text: string }
  | { readonly kind: "branch" }
  | { readonly kind: "test" }
  | { readonly kind: "unknown"; readonly name: string };

export const SLASH_HELP =
  "/edit [text] edit your last message in a new chat · /branch continue from the last reply in a new chat · " +
  "/test save your last message as a test · /bot <name> · /new · /stop · //text sends /text";

/** The command a composer line is, or null when it is a message to send. */
export const parseSlash = (line: string): Slash | null => {
  const text = line.trim();
  if (!text.startsWith("/") || text.startsWith("//")) return null;
  const [head = "", ...rest] = text.slice(1).split(/\s+/);
  const arg = text.slice(1 + head.length).trim();
  switch (head.toLowerCase()) {
    case "help":
    case "?":
      return { kind: "help" };
    case "new":
      return { kind: "new" };
    case "stop":
      return { kind: "stop" };
    case "bot":
      return rest.length === 0 ? { kind: "help" } : { kind: "bot", name: arg };
    case "edit":
      return { kind: "edit", text: arg };
    case "branch":
      return { kind: "branch" };
    case "test":
      return { kind: "test" };
    default:
      return { kind: "unknown", name: head };
  }
};

/** What a composer line sends: "//text" sends "/text". */
export const messageOf = (line: string): string =>
  line.trim().startsWith("//") ? line.trim().slice(1) : line.trim();

/** Your latest message (not machinery: task results, routines, bot mail). */
export const lastOwnerMessage = (
  transcript: readonly TranscriptEntry[],
): { readonly id: number; readonly text: string } | undefined => {
  for (let index = transcript.length - 1; index >= 0; index--) {
    const entry = transcript[index];
    if (entry?.kind === "input" && machineryLine(entry) === undefined) {
      return { id: entry.id, text: entry.text };
    }
  }
  return undefined;
};

/** The bot's latest finished reply. */
export const lastReply = (transcript: readonly TranscriptEntry[]): number | undefined => {
  for (let index = transcript.length - 1; index >= 0; index--) {
    const entry = transcript[index];
    if (entry?.kind === "output" && !entry.streaming && entry.text !== "") return entry.id;
  }
  return undefined;
};
