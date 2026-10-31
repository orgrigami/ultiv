/**
 * Re-read a screen's data when the window regains focus, the way Needs you
 * does (`lib/app-state.tsx`). A screen also reads on mount, so a page visit
 * is covered too. Returns the cleanup for a `useEffect`.
 */
export function reloadOnFocus(
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  reload: () => unknown,
): () => void {
  const onFocus = (): void => void reload();
  target.addEventListener("focus", onFocus);
  return () => target.removeEventListener("focus", onFocus);
}
