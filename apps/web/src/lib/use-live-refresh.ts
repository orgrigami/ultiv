/**
 * Refresh a screen's data when one of its live signals arrives (or on
 * `sync`, after a reconnect). For screens that own their own load function
 * and loading state; `useLiveLoad` is the all-in-one alternative. Bursts
 * collapse: a bot saving five memories refetches once.
 */
import { useEffect, useRef } from "react";
import { onLive, type LiveKind } from "./live.ts";

const BURST_MS = 300;

export function useLiveRefresh(
  kinds: readonly LiveKind[],
  refresh: () => unknown,
  enabled = true,
): void {
  const latest = useRef(refresh);
  latest.current = refresh;
  const key = kinds.join(",");
  useEffect(() => {
    if (!enabled) return;
    const wanted = new Set(key.split(","));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onLive((kind) => {
      if (kind !== "sync" && !wanted.has(kind)) return;
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void latest.current();
      }, BURST_MS);
    });
    return () => {
      off();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [key, enabled]);
}
