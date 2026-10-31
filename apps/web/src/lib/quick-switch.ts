/**
 * The quick switcher's model (Cmd/Ctrl-K): one list of bots, past chats,
 * screens and actions, ranked by how well the typed text matches, and the
 * desktop shortcuts that open things (Cmd/Ctrl-K, N, ?). Pure, so the
 * matching and the key rules are tested without a browser.
 */

export type QuickKind = "action" | "screen" | "bot" | "chat";

export interface QuickItem {
  id: string;
  kind: QuickKind;
  title: string;
  /** One quiet line under the title: the bot, a time, what it does. */
  detail?: string | undefined;
  /** Other words that should find it ("history" for Past chats). */
  keywords?: readonly string[] | undefined;
  /** The key that does the same thing, shown at the row's end. */
  shortcut?: string | undefined;
}

/** Group order when nothing is typed, and the tie-break when scores match. */
const KIND_ORDER: Record<QuickKind, number> = { action: 0, screen: 1, bot: 2, chat: 3 };

export const KIND_LABEL: Record<QuickKind, string> = {
  action: "Actions",
  screen: "Go to",
  bot: "Bots",
  chat: "Past chats",
};

/**
 * How well `query` matches `text`, higher is better; 0 = no match.
 * Whole text > prefix > a word's start > anywhere > letters in order.
 */
export function matchScore(query: string, text: string): number {
  const needle = query.trim().toLowerCase();
  const hay = text.toLowerCase();
  if (needle === "") return 1;
  if (hay === needle) return 100;
  if (hay.startsWith(needle)) return 80;
  const words = hay.split(/[^\p{L}\p{N}]+/u);
  if (words.some((word) => word.startsWith(needle))) return 60;
  if (hay.includes(needle)) return 40;
  // Letters in order ("pc" finds "Past chats"), scored by how tight they sit.
  let at = 0;
  let gaps = 0;
  for (const char of needle) {
    if (char === " ") continue;
    const found = hay.indexOf(char, at);
    if (found === -1) return 0;
    gaps += found - at;
    at = found + 1;
  }
  return Math.max(1, 20 - gaps);
}

function itemScore(query: string, item: QuickItem): number {
  const fields = [item.title, ...(item.keywords ?? [])];
  const best = Math.max(...fields.map((field) => matchScore(query, field)));
  // The detail (a bot's name on a chat) only finds, it never outranks a title.
  const detail = item.detail === undefined ? 0 : Math.min(30, matchScore(query, item.detail));
  return Math.max(best, detail);
}

/**
 * The rows to show for `query`. Empty: actions, screens, bots, then the
 * newest `chatsWhenEmpty` chats, in the order given. Typed: every match,
 * best first, kind order breaking ties; at most `limit`.
 */
export function rankItems(
  items: readonly QuickItem[],
  query: string,
  { limit = 12, chatsWhenEmpty = 5 }: { limit?: number; chatsWhenEmpty?: number } = {},
): QuickItem[] {
  if (query.trim() === "") {
    let chats = 0;
    return [...items]
      .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
      .filter((item) => item.kind !== "chat" || chats++ < chatsWhenEmpty)
      .slice(0, limit);
  }
  return items
    .map((item, index) => ({ item, index, score: itemScore(query, item) }))
    .filter((row) => row.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] || a.index - b.index,
    )
    .slice(0, limit)
    .map((row) => row.item);
}

/** The next highlighted row for an arrow key, wrapping at both ends. */
export function moveActive(index: number, count: number, step: 1 | -1): number {
  if (count === 0) return 0;
  return (index + step + count) % count;
}

export type Shortcut = "switcher" | "new-chat" | "help";

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  /** Whether focus is in a field (input, textarea, contenteditable). */
  typing: boolean;
}

/** Which shortcut a key press means, if any. Bare keys never fire while typing. */
export function shortcutOf(event: KeyLike): Shortcut | null {
  const mod = event.metaKey || event.ctrlKey;
  if (mod && !event.altKey && event.key.toLowerCase() === "k") return "switcher";
  if (mod || event.altKey || event.typing) return null;
  if (event.key === "n" || event.key === "N") return "new-chat";
  if (event.key === "?") return "help";
  return null;
}

/** The sheet ? opens: every shortcut in one place. */
export const SHORTCUTS: readonly { keys: readonly string[]; label: string }[] = [
  { keys: ["⌘", "K"], label: "Find a bot, chat or screen (Ctrl K on Windows and Linux)" },
  { keys: ["N"], label: "New chat with the bot on screen" },
  { keys: ["?"], label: "Show these shortcuts" },
  { keys: ["Enter"], label: "Send (Shift Enter for a new line)" },
  { keys: ["Esc"], label: "Close the work pane or a dialog" },
];
