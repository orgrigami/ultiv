/**
 * Load a REST slice once, then refetch it on its live signal (and on window
 * focus, for a sleeping tab). The first load drives the skeleton and error
 * state; a failed refetch keeps the last good value and raises one "may be
 * out of date" toast instead of a toast per signal. A response for an older
 * key never lands after a newer one (switching rooms mid-request).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { onLive, type LiveKind } from "./live.ts";
import { pollFailed, pollRecovered } from "./notify.ts";

export type LiveLoad<T> = {
  readonly value: T | null;
  /** The first load failed and there is nothing to show. */
  readonly failed: boolean;
  readonly retry: () => void;
};

export function useLiveLoad<T>(
  key: string,
  fetcher: () => Promise<T>,
  kinds: readonly LiveKind[],
  staleTitle: string,
): LiveLoad<T> {
  const [value, setValue] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const kindsKey = kinds.join(",");

  const load = useCallback(
    (first: boolean): void => {
      const mine = ++generation.current;
      if (first) setFailed(false);
      fetcherRef
        .current()
        .then((next) => {
          if (mine !== generation.current) return;
          setValue(next);
          setFailed(false);
          pollRecovered(`live-load:${key}`);
        })
        .catch((cause: unknown) => {
          if (mine !== generation.current) return;
          if (first) setFailed(true);
          else pollFailed(`live-load:${key}`, staleTitle, cause);
        });
    },
    [key, staleTitle],
  );

  useEffect(() => {
    setValue(null);
    load(true);
    const wanted = new Set(kindsKey.split(","));
    const off = onLive((kind) => {
      if (kind === "sync" || wanted.has(kind)) load(false);
    });
    const onFocus = (): void => load(false);
    window.addEventListener("focus", onFocus);
    return () => {
      off();
      window.removeEventListener("focus", onFocus);
      generation.current += 1;
    };
  }, [load, kindsKey]);

  return { value, failed: failed && value === null, retry: () => load(true) };
}
