/**
 * Message actions that act on the chat itself. "Edit" on one of the owner's
 * messages sends the edited text in a NEW chat that holds everything before
 * it; "Branch" on a bot reply continues from that reply in a new chat (the
 * open chat never changes); "Save as a test" keeps an owner message and the
 * bot's answer as a behaviour test (the CLI's /test). The chat provides the
 * actions; anywhere else the transcript renders (no provider) shows none.
 */
import { createContext, useCallback, useContext, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { api } from "@/lib/api";
import { useApp } from "@/lib/app-state";

export type BranchActions = {
  /** Send `text` as an edit of the message `at`, in a new chat; opens it. */
  readonly edit: (at: number, text: string) => Promise<void>;
  /** Continue from the bot reply `at` in a new chat; opens it. */
  readonly branch: (at: number) => Promise<void>;
  /** Save the owner message `at` (and the reply to it) as a behaviour test. */
  readonly saveTest: (at: number) => Promise<void>;
};

const BranchContext = createContext<BranchActions | null>(null);

export const BranchProvider = BranchContext.Provider;

/** The open chat's branch actions, or null where branching does not apply. */
export const useBranch = (): BranchActions | null => useContext(BranchContext);

/** The branch actions of one chat: create the branch, refresh the lists, open it. */
export function useBranchActions(sessionId: string): BranchActions {
  const navigate = useNavigate();
  const { refreshAll } = useApp();
  const open = useCallback(
    async (id: string): Promise<void> => {
      await refreshAll();
      await navigate({ to: "/c/$sessionId", params: { sessionId: id } });
    },
    [navigate, refreshAll],
  );
  const edit = useCallback(
    async (at: number, text: string) =>
      open((await api.branchSession(sessionId, { at, mode: "edit", text })).id),
    [open, sessionId],
  );
  const branch = useCallback(
    async (at: number) => open((await api.branchSession(sessionId, { at, mode: "from" })).id),
    [open, sessionId],
  );
  const saveTest = useCallback(
    async (at: number) => {
      await api.evalCapture(sessionId, at);
    },
    [sessionId],
  );
  return useMemo(() => ({ edit, branch, saveTest }), [edit, branch, saveTest]);
}
