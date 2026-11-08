/**
 * Scrolling for a chat whose composer floats over the transcript: measures
 * the composer (its height becomes the transcript's bottom padding), keeps the
 * newest message in view only while the owner is at the bottom (scrolling up
 * mid-stream stays put), and offers a jump back down.
 */
import { useCallback, useEffect, useRef, useState } from "react";

const viewportOf = (root: HTMLElement | null): Element | null | undefined =>
  root?.querySelector("[data-slot=scroll-area-viewport]");

export function useChatScroll(changes: readonly unknown[]) {
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const footerRef = useRef<HTMLElement | null>(null);
  const [footerHeight, setFooterHeight] = useState(80);
  const pinned = useRef(true);
  // Mirrors pinned for rendering: off the bottom shows "Jump to latest".
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const viewport = viewportOf(transcriptRef.current);
    if (viewport === null || viewport === undefined) return;
    const onScroll = (): void => {
      pinned.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80;
      setAtBottom(pinned.current);
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const footer = footerRef.current;
    if (footer === null) return;
    const observer = new ResizeObserver(() => setFooterHeight(footer.offsetHeight));
    observer.observe(footer);
    return () => observer.disconnect();
  }, []);

  // Content that grows after render (lazy markdown, a card expanding, the
  // checklist strip changing the padding) keeps a pinned transcript at the bottom.
  useEffect(() => {
    const viewport = viewportOf(transcriptRef.current);
    const content = viewport?.firstElementChild;
    if (viewport === null || viewport === undefined || content === null || content === undefined) {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (pinned.current) viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  // Pin the transcript to the newest entry only while the owner is pinned there.
  useEffect(() => {
    const viewport = viewportOf(transcriptRef.current);
    if (viewport === null || viewport === undefined || !pinned.current) return;
    viewport.scrollTop = viewport.scrollHeight;
    // biome-ignore lint/correctness/useExhaustiveDependencies: re-pin on any change
  }, [...changes, footerHeight]);

  const jumpToLatest = useCallback((): void => {
    const viewport = viewportOf(transcriptRef.current);
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    viewport?.scrollTo({ top: viewport.scrollHeight, behavior: still ? "auto" : "smooth" });
  }, []);

  return { transcriptRef, footerRef, footerHeight, atBottom, jumpToLatest };
}

/** CSS for "this far above the composer" (the tab bar / safe area included). */
export const aboveComposer = (footerHeight: number, gap: number): string =>
  `calc(${footerHeight + gap}px + var(--chat-bottom, env(safe-area-inset-bottom)))`;
