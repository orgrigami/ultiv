/**
 * A routine fire that runs as a background task (`CronJobInfo.run: "task"`):
 * the prompt runs AS the bot in its own task conversation, on the bot's
 * background model (model.ts), and the result lands in the bot's main chat
 * as a note (`report: "note"`), never as a main-chat turn. The main thread
 * stays short; the bot still reads the result with its next turn.
 */
import { Effect } from "effect";
import { NOTHING_TO_REPORT, type TaskInfo } from "@spriessen/contracts";
import { InvalidInput, NotFound } from "@spriessen/core";
import type { ConverseService } from "../converse/converse.ts";
import type { ModelCatalogService } from "../providers/models.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import { backgroundModelFor } from "./model.ts";
import type { TasksService } from "./tasks.ts";

/** How a routine task says it found nothing worth its owner's attention (no push). */
export const QUIET_ROUTINE = `(A routine run: if nothing changed that your owner needs to see, use or act on, your whole result is exactly ${NOTHING_TO_REPORT}.)`;

/** Background tasks a routine starts are filed under the agent owner label. */
const ROUTINE_TASK_OWNER = "agent";

export type BackgroundDeps = {
  readonly tasks: TasksService;
  readonly profiles: ProfilesService;
  readonly converse: ConverseService;
  readonly models: Pick<ModelCatalogService, "list" | "find">;
};

/** Whether a ref is in the live catalog; an empty catalog (first boot offline) cannot judge. */
export const catalogKnows =
  (models: BackgroundDeps["models"]) =>
  (ref: string): boolean =>
    models.list().length === 0 || models.find(ref) !== undefined;

/** Run a routine's prompt as a background task reporting into `sessionId`'s chat. */
export const spawnBackgroundRoutine = async (
  deps: BackgroundDeps,
  input: { readonly sessionId: string; readonly prompt: string; readonly title: string },
): Promise<TaskInfo> => {
  const row = await deps.profiles.rowOf(input.sessionId);
  if (row === undefined) throw new NotFound({ what: `session ${input.sessionId}` });
  const conversation = await Effect.runPromise(
    deps.converse.ensure(await deps.profiles.keyOfRow(row)),
  );
  const profile = await deps.profiles.get(row.owner, row.profile);
  const choice = backgroundModelFor(profile, {}, catalogKnows(deps.models));
  if (!choice.ok) throw new InvalidInput({ reason: choice.reason });
  return Effect.runPromise(
    deps.tasks.spawn({
      sessionId: input.sessionId,
      owner: ROUTINE_TASK_OWNER,
      conversationId: String(conversation.id),
      prompt: `${input.prompt}\n\n${QUIET_ROUTINE}`,
      title: input.title,
      report: "note",
      ...(choice.model !== undefined ? { model: choice.model } : {}),
    }),
  );
};
