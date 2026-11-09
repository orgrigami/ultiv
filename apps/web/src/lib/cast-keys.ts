/**
 * The keyboard of the live takeover view. A real keyboard is read key by key
 * (`keyDecision`); a PHONE's on-screen keyboard opens only for an editable
 * field and sends its text as `input` (its keydowns say "Unidentified"), so
 * the view keeps a hidden field and reads back what lands in it
 * (`catcherActs`). The field always holds one SENTINEL character, so a
 * Backspace on a field that looks empty still deletes something it can
 * report. Pasted text arrives the same way, as typing.
 */

/** Named keys the page understands (mirrors the broker's KEYCODES). */
export const PAGE_KEYS: ReadonlySet<string> = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "ArrowLeft",
  "ArrowUp",
  "ArrowRight",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

export type KeyDecision =
  | { readonly send: "type"; readonly text: string }
  | { readonly send: "key"; readonly key: string }
  | { readonly send: "escape" }
  | { readonly send: "passthrough" };

/**
 * What one keystroke means while the live view holds focus: printable text
 * and the page's named keys go to the page, Escape releases focus back to
 * the app, and anything with a modifier (the browser's and the app's own
 * shortcuts, paste included — the paste event carries its text) never
 * reaches the bot's browser as a key.
 */
export const keyDecision = (key: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}): KeyDecision => {
  if (key.ctrlKey || key.metaKey || key.altKey) return { send: "passthrough" };
  if (key.key === "Escape") return { send: "escape" };
  if (PAGE_KEYS.has(key.key)) return { send: "key", key: key.key };
  // A bare key of length 1 is a printable character (space, letters, punctuation).
  if (key.key.length === 1) return { send: "type", text: key.key };
  return { send: "passthrough" };
};

/** A zero-width space: invisible, and one character for Backspace to remove. */
export const KEY_SENTINEL = "​";

export type KeyAct = { a: "type"; text: string } | { a: "key"; key: string };

/** Text as acts: line breaks are Enter presses, the rest is typed. */
export const textActs = (text: string): KeyAct[] => {
  const acts: KeyAct[] = [];
  text.split(/\r?\n/).forEach((part, index) => {
    if (index > 0) acts.push({ a: "key", key: "Enter" });
    if (part !== "") acts.push({ a: "type", text: part });
  });
  return acts;
};

/** What the hidden field's value means after one edit (the field then resets). */
export const catcherActs = (value: string): KeyAct[] => {
  if (value === KEY_SENTINEL) return [];
  // The sentinel itself went: a Backspace on the "empty" field.
  if (value === "") return [{ a: "key", key: "Backspace" }];
  if (value.startsWith(KEY_SENTINEL)) return textActs(value.slice(KEY_SENTINEL.length));
  // The caret sat before the sentinel, or the keyboard rewrote the field
  // (autocorrect): whatever is not the sentinel was typed.
  return textActs(value.replaceAll(KEY_SENTINEL, ""));
};
