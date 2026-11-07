/**
 * Slash commands typed into the composer: the chat's actions the web puts
 * on buttons and menus. One table drives the parser, the hint line under
 * the composer, tab completion and the help overlay. Pure parsing and
 * transcript lookups here; the TUI runs them (use-slash.ts). `//text` sends
 * "/text" as a message.
 */
import type { TranscriptEntry } from "@spriessen/contracts";
import { machineryLine } from "../render/words.ts";

export type Slash =
  | { readonly kind: "help" }
  | { readonly kind: "new" }
  | { readonly kind: "stop" }
  | { readonly kind: "retry" }
  | { readonly kind: "bot"; readonly name: string }
  | { readonly kind: "chats" }
  | { readonly kind: "model"; readonly id: string }
  | { readonly kind: "edit"; readonly text: string }
  | { readonly kind: "branch" }
  | { readonly kind: "test" }
  | { readonly kind: "copy" }
  | { readonly kind: "open" }
  | { readonly kind: "unknown"; readonly name: string };

export interface SlashSpec {
  readonly name: string;
  readonly args?: string;
  readonly about: string;
}

export const SLASH_COMMANDS: readonly SlashSpec[] = [
  { name: "help", about: "keys and commands" },
  { name: "new", about: "a new chat with this bot" },
  { name: "chats", about: "switch to another of this bot's chats" },
  { name: "bot", args: "[name]", about: "switch bots (the start of a name is enough)" },
  { name: "model", args: "[id]", about: "this chat's model (bare: pick from a list)" },
  { name: "edit", args: "[text]", about: "edit your last message in a new chat" },
  { name: "branch", about: "continue from the last reply in a new chat" },
  { name: "copy", about: "copy the last reply to the clipboard" },
  { name: "retry", about: "send the messages a failed run left queued" },
  { name: "stop", about: "stop the reply" },
  { name: "test", about: "save your last message as a test" },
  { name: "open", about: "open this chat in the browser" },
];

export const SLASH_HELP =
  "/help for everything · /new · /chats · /bot · /model · /edit · /branch · /copy · //text sends /text";

/** The command a composer line is, or null when it is a message to send. */
export const parseSlash = (line: string): Slash | null => {
  const text = line.trim();
  if (!text.startsWith("/") || text.startsWith("//")) return null;
  const head = text.slice(1).split(/\s+/)[0] ?? "";
  const arg = text.slice(1 + head.length).trim();
  switch (head.toLowerCase()) {
    case "help":
    case "?":
      return { kind: "help" };
    case "new":
      return { kind: "new" };
    case "stop":
      return { kind: "stop" };
    case "retry":
      return { kind: "retry" };
    case "bot":
    case "bots":
      return { kind: "bot", name: arg };
    case "chats":
    case "chat":
      return { kind: "chats" };
    case "model":
      return { kind: "model", id: arg };
    case "edit":
      return { kind: "edit", text: arg };
    case "branch":
      return { kind: "branch" };
    case "test":
      return { kind: "test" };
    case "copy":
      return { kind: "copy" };
    case "open":
      return { kind: "open" };
    default:
      return { kind: "unknown", name: head };
  }
};

/** The commands a half-typed `/wor` could be (empty once a space follows the name). */
export const slashMatches = (draft: string): readonly SlashSpec[] => {
  if (!draft.startsWith("/") || draft.startsWith("//") || /\s/.test(draft)) return [];
  const typed = draft.slice(1).toLowerCase();
  return SLASH_COMMANDS.filter((spec) => spec.name.startsWith(typed));
};

/** Tab on a half-typed command: the completed draft, or undefined when it is not one. */
export const completeSlash = (draft: string): string | undefined => {
  const matches = slashMatches(draft);
  if (matches.length === 0) return undefined;
  if (matches.length === 1) {
    const only = matches[0] as SlashSpec;
    return `/${only.name}${only.args !== undefined ? " " : ""}`;
  }
  // The longest shared start of every match.
  const names = matches.map((spec) => spec.name);
  let shared = names[0] ?? "";
  for (const name of names) while (!name.startsWith(shared)) shared = shared.slice(0, -1);
  return `/${shared}`;
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
export const lastReply = (
  transcript: readonly TranscriptEntry[],
): { readonly id: number; readonly text: string } | undefined => {
  for (let index = transcript.length - 1; index >= 0; index--) {
    const entry = transcript[index];
    if (entry?.kind === "output" && !entry.streaming && entry.text !== "") {
      return { id: entry.id, text: entry.text };
    }
  }
  return undefined;
};
