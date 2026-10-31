/** A CSS media query as React state (false during SSR and tests without a window). */
import { useSyncExternalStore } from "react";

export const WIDE = "(min-width: 1024px)";

export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
