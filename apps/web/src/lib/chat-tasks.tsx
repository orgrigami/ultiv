/**
 * The open chat's background tasks, for the pieces of the transcript that
 * draw a task live (the line under "Started a task"). Provided by the chat
 * from its one task list (use-tasks.ts), so every line updates with the
 * `tasks` live signal and nothing polls on its own.
 */
import { createContext, useContext } from "react";
import type { TaskRow } from "@spriessen/contracts";

export interface ChatTasksValue {
  readonly tasks: readonly TaskRow[];
  readonly refresh: () => Promise<void>;
}

const ChatTasksContext = createContext<ChatTasksValue | null>(null);

export const ChatTasksProvider = ChatTasksContext.Provider;

/** The open chat's tasks; null outside a chat (a task sheet, a test). */
export const useChatTasks = (): ChatTasksValue | null => useContext(ChatTasksContext);
