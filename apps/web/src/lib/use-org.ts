/**
 * The org as one live reading, shared by every component that asks: one
 * fetch in flight at a time, refetched whenever an org change announces
 * itself (`ORG_CHANGED`) or a caller's dependency (the bot count) moves.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { ORG_CHANGED, orgApi, type OrgView } from "./org-api.ts";

interface OrgSnapshot {
  readonly view: OrgView | null;
  readonly error: string | null;
}

let snapshot: OrgSnapshot = { view: null, error: null };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

const publish = (next: OrgSnapshot): void => {
  snapshot = next;
  for (const listener of listeners) listener();
};

/** Fetches the org once, however many readers ask at the same moment. */
export const loadOrg = (): Promise<void> => {
  inflight ??= orgApi
    .view()
    .then((view) => publish({ view, error: null }))
    .catch((cause: unknown) =>
      publish({ ...snapshot, error: cause instanceof Error ? cause.message : String(cause) }),
    )
    .finally(() => {
      inflight = null;
    });
  return inflight;
};

const onChanged = (): void => void loadOrg();

const subscribe = (listener: () => void): (() => void) => {
  if (listeners.size === 0) window.addEventListener(ORG_CHANGED, onChanged);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener(ORG_CHANGED, onChanged);
  };
};

const read = (): OrgSnapshot => snapshot;

export function useOrg(dependency?: unknown): {
  view: OrgView | null;
  error: string | null;
  reload: () => Promise<void>;
} {
  const current = useSyncExternalStore(subscribe, read, read);
  useEffect(() => {
    void loadOrg();
  }, [dependency]);
  const reload = useCallback(() => loadOrg(), []);
  return { view: current.view, error: current.error, reload };
}
