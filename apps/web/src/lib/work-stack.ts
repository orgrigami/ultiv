/**
 * What the work dock shows: a small set of TABS, each a short trail of items,
 * so more than one thing can be open beside the chat at once. Opening from
 * the chat (fresh) focuses the tab whose root is the same thing, or adds a
 * new tab (a fresh ask is a new look, not a reroute); opening from inside
 * the dock pushes onto the active tab's trail (Back returns). The dock keeps
 * a bounded set of tabs and each trail stays a few steps, so both stay
 * predictable rather than growing into a history.
 */
import type { TaskInfo } from "@spriessen/contracts";
import type { FileRef } from "./file-meta.ts";

export type WorkItem =
  | { readonly kind: "task"; readonly task: TaskInfo }
  | { readonly kind: "file"; readonly file: FileRef }
  | {
      readonly kind: "memory";
      readonly profileId: string;
      readonly name: string;
      readonly query?: string | undefined;
    }
  | { readonly kind: "needs" }
  /** Every bot's browser: open takeover asks to drive, live sessions to watch. */
  | { readonly kind: "browsers" }
  | {
      readonly kind: "room";
      readonly roomId: string;
      /** Participant names joined "A ↔ B" — resolved before opening. */
      readonly title: string;
      readonly topic: string | null;
    };

/** Tabs the dock keeps; a newer open evicts the oldest tab that isn't active. */
export const WORK_TABS_LIMIT = 5;
/** Steps one tab's trail may hold; the oldest step falls off, like before. */
export const WORK_TRAIL_LIMIT = 3;

export interface WorkTab {
  /** The tab's identity: what was opened from outside. */
  readonly root: WorkItem;
  /** What was opened from inside it, oldest first; the root is trail[0]. */
  readonly trail: readonly WorkItem[];
}

/** Two items with the same key are the same thing (a task, a file, a bot's memory). */
export function workKey(item: WorkItem): string {
  switch (item.kind) {
    case "task":
      return `task:${item.task.id}`;
    case "file":
      return `file:${item.file.id}`;
    case "memory":
      return `memory:${item.profileId}`;
    case "needs":
      return "needs";
    case "browsers":
      return "browsers";
    case "room":
      return `room:${item.roomId}`;
  }
}

/** The item a tab shows now: the newest trail step, or the root itself. */
export function tabTop(tab: WorkTab): WorkItem {
  return tab.trail.at(-1) ?? tab.root;
}

export interface WorkDock {
  readonly tabs: readonly WorkTab[];
  /** The active tab's root key; null when nothing is open. */
  readonly active: string | null;
}

export const emptyDock: WorkDock = { tabs: [], active: null };

export type WorkAction =
  | { readonly type: "open"; readonly item: WorkItem; readonly fresh?: boolean }
  | { readonly type: "select"; readonly key: string }
  /** Closes one tab by root key, or the active tab when no key is given. */
  | { readonly type: "close"; readonly key?: string }
  | { readonly type: "back" };

const keyOf = (tab: WorkTab): string => workKey(tab.root);

/** Focuses a tab and makes it the active one, replacing its whole trail. */
function refocus(dock: WorkDock, key: string, item: WorkItem): WorkDock {
  const tabs = dock.tabs.map((tab) => (keyOf(tab) === key ? { root: item, trail: [item] } : tab));
  return { tabs, active: key };
}

export function workDock(dock: WorkDock, action: WorkAction): WorkDock {
  if (action.type === "select") {
    return dock.tabs.some((tab) => keyOf(tab) === action.key)
      ? { ...dock, active: action.key }
      : dock;
  }
  if (action.type === "close") {
    const key = action.key ?? dock.active;
    if (key === null) return dock;
    const tabs = dock.tabs.filter((tab) => keyOf(tab) !== key);
    const last = tabs.at(-1);
    const active = dock.active === key ? (last !== undefined ? keyOf(last) : null) : dock.active;
    return { tabs, active };
  }
  if (action.type === "back") {
    const active = dock.tabs.find((tab) => keyOf(tab) === dock.active);
    if (active === undefined || active.trail.length <= 1) return dock;
    const tabs = dock.tabs.map((tab) =>
      tab === active ? { ...tab, trail: tab.trail.slice(0, -1) } : tab,
    );
    return { ...dock, tabs };
  }
  // An open from inside the dock joins the active tab's trail. The root
  // never falls off: the cap trims the middle steps, not the first.
  if (action.fresh !== true) {
    const active = dock.tabs.find((tab) => keyOf(tab) === dock.active);
    if (active !== undefined) {
      const top = tabTop(active);
      const trail =
        workKey(top) === workKey(action.item)
          ? [...active.trail.slice(0, -1), action.item]
          : [
              active.root,
              ...[...active.trail.slice(1), action.item].slice(-(WORK_TRAIL_LIMIT - 1)),
            ];
      const tabs = dock.tabs.map((tab) => (tab === active ? { ...tab, trail } : tab));
      return { ...dock, tabs };
    }
  }
  // A fresh open (or an open with no dock yet): reuse the same root's tab,
  // else add one — evicting the oldest tab that isn't being looked at.
  const key = workKey(action.item);
  if (dock.tabs.some((tab) => keyOf(tab) === key)) return refocus(dock, key, action.item);
  let tabs = dock.tabs;
  if (tabs.length >= WORK_TABS_LIMIT) {
    const evict = tabs.find((tab) => keyOf(tab) !== dock.active);
    if (evict !== undefined) tabs = tabs.filter((tab) => tab !== evict);
  }
  return { tabs: [...tabs, { root: action.item, trail: [action.item] }], active: key };
}
