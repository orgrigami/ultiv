/**
 * The crew's collapsed team groups, remembered in this browser and
 * kept in step across every list on screen (the rail and the bot pill).
 */
import { useCallback, useSyncExternalStore } from "react";
import { COLLAPSED_KEY, parseCollapsed, toggleCollapsed } from "./org-view.ts";

const EVENT = "spriessen:crew-collapsed";

const readRaw = (): string | null => {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY);
  } catch {
    return null;
  }
};

const subscribe = (listener: () => void): (() => void) => {
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", listener);
  };
};

const write = (next: readonly string[]): void => {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
  } catch {
    // Private mode: nothing is remembered; the event still repaints.
  }
  window.dispatchEvent(new Event(EVENT));
};

export function useCollapsed(): {
  collapsed: Set<string>;
  toggle: (id: string) => void;
  /** Opens a group if it is collapsed; safe to call from several lists. */
  expand: (id: string) => void;
} {
  const raw = useSyncExternalStore(subscribe, readRaw, () => null);
  const toggle = useCallback((id: string): void => {
    write(toggleCollapsed(parseCollapsed(readRaw()), id));
  }, []);
  const expand = useCallback((id: string): void => {
    const now = parseCollapsed(readRaw());
    if (now.has(id)) write(toggleCollapsed(now, id));
  }, []);
  return { collapsed: parseCollapsed(raw), toggle, expand };
}
