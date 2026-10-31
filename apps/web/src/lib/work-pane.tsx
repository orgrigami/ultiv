/**
 * The work pane's state, shared app-wide: the chat, the task pill, file cards
 * and memory chips open things here. On desktop (≥1024px) the pane sits
 * beside the chat; below that the same content opens as a full-screen sheet.
 */
import { createContext, useCallback, useContext, useMemo, useReducer } from "react";
import { workStack, type WorkItem } from "./work-stack.ts";

export interface WorkPaneState {
  readonly item: WorkItem | null;
  readonly canBack: boolean;
  /** `fresh` starts a new trail (opened from the chat, not from inside the pane). */
  readonly open: (item: WorkItem, fresh?: boolean) => void;
  readonly back: () => void;
  readonly close: () => void;
}

const WorkPaneContext = createContext<WorkPaneState | null>(null);

export function WorkPaneProvider({ children }: { children: React.ReactNode }) {
  const [stack, dispatch] = useReducer(workStack, []);
  const open = useCallback(
    (item: WorkItem, fresh?: boolean) =>
      dispatch({ type: "open", item, ...(fresh === undefined ? {} : { fresh }) }),
    [],
  );
  const back = useCallback(() => dispatch({ type: "back" }), []);
  const close = useCallback(() => dispatch({ type: "close" }), []);
  const value = useMemo(
    () => ({ item: stack.at(-1) ?? null, canBack: stack.length > 1, open, back, close }),
    [stack, open, back, close],
  );
  return <WorkPaneContext.Provider value={value}>{children}</WorkPaneContext.Provider>;
}

/** True inside the pane, so what opens from there joins the trail (Back returns). */
export const InWorkPane = createContext(false);

/**
 * Open something in the work pane: from the chat it starts a new trail, from
 * inside the pane it pushes (Back returns). Null outside the provider.
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
