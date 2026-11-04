/**
 * Every key the TUI answers, in one place (the footer shows the same list):
 *
 *   ctrl-c quit · tab chat ↔ Needs you · ctrl-k pick a bot · ctrl-n new chat
 *   pgup/pgdn scroll · esc stop the reply (or answer a waiting card)
 *   ctrl-r send the next message as a redirect · ctrl-t send what is queued
 *   card: a approve · d deny · A always allow · i back to typing
 *   Needs you: ↑/↓ choose · a/d/A decide · enter open its chat
 *
 * Bare letters only act while a card holds the keyboard, never while typing.
 */
import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";

export interface KeyActions {
  readonly view: "chat" | "needs";
  readonly picking: boolean;
  readonly cardFocused: boolean;
  readonly hasCard: boolean;
  readonly working: boolean;
  quit(): void;
  toggleView(): void;
  openPicker(): void;
  closePicker(): void;
  newChat(): void;
  scroll(pages: number): void;
  stop(): void;
  focusCard(focused: boolean): void;
  decide(approved: boolean, always?: boolean): void;
  toggleRedirect(): void;
  retryQueued(): void;
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

/** The pure dispatch (tested without a terminal); answers whether the key was used. */
export const dispatchKey = (key: KeyEvent, act: KeyActions): boolean => {
  if (key.ctrl && key.name === "c") return (act.quit(), true);
  if (act.picking) return key.name === "escape" ? (act.closePicker(), true) : false;
  if (key.name === "tab") return (act.toggleView(), true);
  if (key.ctrl && key.name === "k") return (act.openPicker(), true);
  if (key.ctrl && key.name === "n") return (act.newChat(), true);
  if (key.name === "pageup") return (act.scroll(-1), true);
  if (key.name === "pagedown") return (act.scroll(1), true);
  if (act.view === "needs") {
    if (key.name === "up") return (act.needsMove(-1), true);
    if (key.name === "down") return (act.needsMove(1), true);
    if (key.name === "return") return (act.needsOpen(), true);
    const choice = decision(key);
    if (choice !== undefined) return (act.needsDecide(choice.approved, choice.always), true);
    return false;
  }
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
