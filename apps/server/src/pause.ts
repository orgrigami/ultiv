/**
 * The global pause (Settings › Pause the crew) as the triggers see it. While
 * on, a routine fire settles its write-ahead receipt "held" instead of
 * waking anyone: the fire HAPPENED (the receipt proves it), nothing ran, and
 * nothing replays on resume — pause holds like downtime, it does not queue.
 * A one-shot held this way stays listed, unfired, and fires on the next boot
 * after resume (the same rule as a one-shot whose time passed in downtime).
 */
import { settleRoutineEvent, type MindService } from "@spriessen/mind";

/**
 * After a fire's write-ahead receipt: true when the workspace is paused (the
 * receipt has been settled "held" and the caller must deliver NOTHING).
 */
export const holdIfPaused = async (mind: MindService, eventId: string): Promise<boolean> => {
  if (!(await mind.profiles.workspacePaused().catch(() => false))) return false;
  await settleRoutineEvent(mind.converse, eventId, "held", "workspace paused");
  return true;
};
