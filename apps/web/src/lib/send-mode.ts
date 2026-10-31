import type { SendMode } from "@spreissen/contracts";

/** One choice in the send button's long-press menu while the bot works. */
export type SendChoice = { readonly mode: SendMode; readonly label: string; readonly hint: string };

/** The busy-send menu, default first; Redirect now is explicit and last. */
export const SEND_CHOICES: readonly SendChoice[] = [
  { mode: "steer", label: "Send now", hint: "Joins at the next step" },
  { mode: "followUp", label: "Send after it finishes", hint: "Waits for this reply" },
  {
    mode: "redirect",
    label: "Redirect now",
    hint: "Stops this reply and answers your message instead",
  },
];

/** Whether the visible Redirect now button shows: only mid-turn, with something to send. */
export function canRedirect(
  busy: boolean,
  live: boolean,
  sending: boolean,
  draft: string,
): boolean {
  return busy && live && !sending && draft.trim() !== "";
}

/** The composer key map: Enter sends (steer), Alt+Enter waits, Ctrl/Cmd+Shift+Enter redirects. */
export function keySendMode(
  event: { altKey: boolean; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  busy: boolean,
): SendMode | undefined {
  if (busy && event.shiftKey && (event.ctrlKey || event.metaKey)) return "redirect";
  return event.altKey ? "followUp" : undefined;
}
