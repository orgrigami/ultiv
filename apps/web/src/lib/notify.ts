/**
 * One place for "that didn't work" — a toast with the server's own reason.
 * Pass an id for anything that can repeat (polls, refreshes) so it shows once.
 */
import { toast } from "sonner";
import { networkText } from "./error-words.ts";

export const errorText = (cause: unknown): string =>
  cause instanceof Error ? networkText(cause.message) : String(cause);

export function notifyError(title: string, cause: unknown, id?: string): void {
  toast.error(title, { description: errorText(cause), ...(id !== undefined ? { id } : {}) });
}

/** A poll that failed once toasts once; recovery dismisses it. */
export function pollFailed(id: string, title: string, cause: unknown): void {
  notifyError(title, cause, id);
}

export function pollRecovered(id: string): void {
  toast.dismiss(id);
}
