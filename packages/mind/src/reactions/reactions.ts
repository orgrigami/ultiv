/**
 * The rules of the `react` tool, pure so the tool and the tests read the
 * same table. A reaction marks the owner's LATEST message: a real input
 * the owner typed, never machinery placed as a user message (task wakes,
 * webhooks, sensors, cron, a parent's steer, bot mail, which the projection
 * turns into notes). The model never sees transcript ids, so there is no
 * target to choose.
 */
import type { TranscriptEntry } from "@spriessen/contracts";

/** Bracketed inputs the app places as user messages; the web shows them as cards. */
const MACHINERY = /^\[(task |webhook |sensor |cron |resume\]|onboarding\]|from parent\])/;

/** Whether a projected step is a message the owner wrote. */
export const isOwnerMessage = (step: TranscriptEntry): boolean =>
  step.kind === "input" && !MACHINERY.test(step.text);

/** The transcript id of the owner's latest message, or undefined when there is none. */
export const latestOwnerMessage = (steps: readonly TranscriptEntry[]): number | undefined => {
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index];
    if (step !== undefined && isOwnerMessage(step)) return step.id;
  }
  return undefined;
};
