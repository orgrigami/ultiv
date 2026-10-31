/**
 * What the work pane shows, as a small stack: opening something pushes it,
 * Back pops, Close clears. Opening what is already on top replaces it (a
 * fresher copy of the same task), and the stack never grows past a few steps,
 * so Back stays a short, predictable trail rather than a history.
 */
import type { TaskInfo } from "@ultiv/contracts";
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
  | { readonly kind: "needs" };

export const WORK_STACK_LIMIT = 4;

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
  }
}

export type WorkAction =
  | { readonly type: "open"; readonly item: WorkItem; readonly fresh?: boolean }
  | { readonly type: "back" }
  | { readonly type: "close" };

export function workStack(stack: readonly WorkItem[], action: WorkAction): readonly WorkItem[] {
  if (action.type === "close") return [];
  if (action.type === "back") return stack.slice(0, -1);
  // A fresh open (from the chat, not from inside the pane) starts a new trail.
  if (action.fresh === true) return [action.item];
  const top = stack.at(-1);
  if (top !== undefined && workKey(top) === workKey(action.item))
    return [...stack.slice(0, -1), action.item];
  return [...stack, action.item].slice(-WORK_STACK_LIMIT);
}
