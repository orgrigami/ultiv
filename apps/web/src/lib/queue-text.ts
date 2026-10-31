import type { TranscriptEntry, WhenBusy } from "@spreissen/contracts";

/**
 * What the running turn is doing, as far as a queued message cares: a steered
 * message only lands at a tool boundary, so while the bot is writing its
 * reply (newest entry is text, no tool round open) it waits for the reply.
 */
export type TurnActivity = "writing" | "working";

export function turnActivity(transcript: readonly TranscriptEntry[]): TurnActivity {
  const last = transcript.at(-1);
  return last?.kind === "output" ? "writing" : "working";
}

/** Under queued messages once no turn is running: they never send by themselves (D3). */
export const STALLED_LABEL = "Not sent: the last turn did not finish";

/** What a queued message says about when it reaches the bot — always true. */
export function queueLabel(
  mode: WhenBusy,
  approvalPending: boolean,
  activity: TurnActivity = "working",
  stalled = false,
): string {
  if (stalled) return STALLED_LABEL;
  if (approvalPending) return "Waiting for your approval first";
  if (mode !== "steer") return "Will send after it finishes";
  return activity === "writing"
    ? "Will answer right after this reply"
    : "Will send at the next step";
}
