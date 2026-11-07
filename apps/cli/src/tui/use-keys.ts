/**
 * Every key the TUI answers, in one place. KEY_HELP is the list /help
 * shows; the footer shows the most useful few. Bare letters only act while
 * a card holds the keyboard (or in Needs you), never while typing. While a
 * picker or the help panel is open it owns the keyboard: esc closes it.
 */
import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";

export const KEY_HELP: readonly (readonly [string, string])[] = [
  ["enter", "send (while the bot works: steer the running turn)"],
  ["ctrl-r", "arm the next send as a redirect (stop and answer this)"],
  ["esc", "answer the waiting card, else stop the reply"],
  ["a / d / A", "on a card: approve / deny / always allow"],
  ["i", "leave the card, back to typing"],
  ["ctrl-t", "send messages a failed run left queued"],
  ["tab", "complete a /command, else Needs you ↔ chat"],
  ["ctrl-k", "pick a bot"],
  ["ctrl-o", "pick one of this bot's chats"],
  ["ctrl-n", "a new chat with this bot"],
  ["pgup / pgdn", "scroll the chat"],
  ["ctrl-c", "quit"],
];

export interface KeyActions {
  readonly view: "chat" | "needs";
  /** A picker or the help panel is open. */
  readonly overlay: boolean;
  readonly cardFocused: boolean;
  readonly hasCard: boolean;
  readonly working: boolean;
  quit(): void;
  toggleView(): void;
  openPicker(): void;
  openChats(): void;
  closeOverlay(): void;
  newChat(): void;
  scroll(pages: number): void;
  stop(): void;
  focusCard(focused: boolean): void;
  decide(approved: boolean, always?: boolean): void;
  toggleRedirect(): void;
  retryQueued(): void;
  /** Tab on a half-typed /command: completes it and answers true. */
  complete(): boolean;
  needsMove(delta: number): void;
  needsDecide(approved: boolean, always?: boolean): void;
  needsOpen(): void;
}

const decision = (key: KeyEvent): { approved: boolean; always?: boolean } | undefined => {
  if (key.name === "a" && key.shift) return { approved: true, always: true };
  if (key.name === "a") return { approved: true };
  if (key.name === "d") return { approved: false };
  return undefined;
};

const needsKey = (key: KeyEvent, act: KeyActions): boolean => {
  if (key.name === "up") return (act.needsMove(-1), true);
  if (key.name === "down") return (act.needsMove(1), true);
  if (key.name === "return") return (act.needsOpen(), true);
  const choice = decision(key);
  if (choice !== undefined) return (act.needsDecide(choice.approved, choice.always), true);
  return false;
};

/** The pure dispatch (tested without a terminal); answers whether the key was used. */
export const dispatchKey = (key: KeyEvent, act: KeyActions): boolean => {
  if (key.ctrl && key.name === "c") return (act.quit(), true);
  if (act.overlay) return key.name === "escape" ? (act.closeOverlay(), true) : false;
  if (key.name === "tab") {
    if (act.view === "chat" && !act.cardFocused && act.complete()) return true;
    return (act.toggleView(), true);
  }
  if (key.ctrl && key.name === "k") return (act.openPicker(), true);
  if (key.ctrl && key.name === "o") return (act.openChats(), true);
  if (key.ctrl && key.name === "n") return (act.newChat(), true);
  if (key.name === "pageup") return (act.scroll(-1), true);
  if (key.name === "pagedown") return (act.scroll(1), true);
  if (act.view === "needs") return needsKey(key, act);
  if (act.cardFocused) {
    if (key.name === "i" || key.name === "escape") return (act.focusCard(false), true);
    const choice = decision(key);
    if (choice !== undefined) return (act.decide(choice.approved, choice.always), true);
    return true; // the card holds the keyboard: nothing leaks into the composer
  }
  if (key.ctrl && key.name === "r") return (act.toggleRedirect(), true);
  if (key.ctrl && key.name === "t") return (act.retryQueued(), true);
  if (key.name === "escape") {
    if (act.hasCard) return (act.focusCard(true), true);
    if (act.working) return (act.stop(), true);
  }
  return false;
};

export const useKeys = (act: KeyActions): void => {
  useKeyboard((key) => {
    dispatchKey(key, act);
  });
};
