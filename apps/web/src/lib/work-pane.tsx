/**
 * The work dock's state, shared app-wide: the chat, task lines, file cards
 * and memory chips open things here. The dock holds several tabs at once
 * (the strip in the pane switches them); on desktop (≥1024px) the dock sits
 * beside the chat, below that the active tab opens as a full-screen sheet.
 */
import { createContext, useCallback, useContext, useMemo, useReducer } from "react";
import { tabTop, workDock, workKey, type WorkItem } from "./work-stack.ts";

/** One entry of the tab strip: the tab's key and the item it shows now. */
export interface WorkTabRow {
  readonly key: string;
  readonly item: WorkItem;
}

export interface WorkPaneState {
  /** The item the dock shows now (the active tab's top). */
  readonly item: WorkItem | null;
  /** Back can step within the active tab's trail. */
  readonly canBack: boolean;
  /** The open tabs in order, for the strip. */
  readonly tabs: readonly WorkTabRow[];
  readonly activeKey: string | null;
  readonly select: (key: string) => void;
  /** Closes one tab by key (or the active one). The pane leaves when none are left. */
  readonly closeTab: (key: string) => void;
  /** `fresh` opens a tab of its own (from the chat); from inside the dock it joins the active trail. */
  readonly open: (item: WorkItem, fresh?: boolean) => void;
  readonly back: () => void;
  /** Closes the active tab (the header's ✕ and Escape). */
  readonly close: () => void;
}

const WorkPaneContext = createContext<WorkPaneState | null>(null);

export function WorkPaneProvider({ children }: { children: React.ReactNode }) {
  const [dock, dispatch] = useReducer(workDock, { tabs: [], active: null });
  const open = useCallback(
    (item: WorkItem, fresh?: boolean) =>
      dispatch({ type: "open", item, ...(fresh === undefined ? {} : { fresh }) }),
    [],
  );
  const select = useCallback((key: string) => dispatch({ type: "select", key }), []);
  const closeTab = useCallback((key: string) => dispatch({ type: "close", key }), []);
  const back = useCallback(() => dispatch({ type: "back" }), []);
  const close = useCallback(() => dispatch({ type: "close" }), []);
  const value = useMemo<WorkPaneState>(() => {
    const activeTab = dock.tabs.find((tab) => workKey(tab.root) === dock.active);
    return {
      item: activeTab !== undefined ? tabTop(activeTab) : null,
      canBack: (activeTab?.trail.length ?? 1) > 1,
      tabs: dock.tabs.map((tab) => ({ key: workKey(tab.root), item: tabTop(tab) })),
      activeKey: dock.active,
      select,
      closeTab,
      open,
      back,
      close,
    };
  }, [dock, select, closeTab, open, back, close]);
  return <WorkPaneContext.Provider value={value}>{children}</WorkPaneContext.Provider>;
}

/** True inside the dock, so what opens from there joins the active tab's trail (Back returns). */
export const InWorkPane = createContext(false);

/**
 * Open something in the work dock: from the chat it opens (or focuses) a tab,
 * from inside the dock it pushes onto the active tab's trail (Back returns).
 * Null outside the provider.
 */
export function useOpenWork(): ((item: WorkItem) => void) | null {
  const pane = useContext(WorkPaneContext);
  const inPane = useContext(InWorkPane);
  return useMemo(
    () => (pane === null ? null : (item: WorkItem) => pane.open(item, !inPane)),
    [pane, inPane],
  );
}

/** Null outside the provider, so a component can fall back to its own dialog. */
export function useWorkPane(): WorkPaneState | null {
  return useContext(WorkPaneContext);
}
