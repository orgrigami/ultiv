/**
 * `memory_update`: one tool for what happens to a fact you already hold,
 * addressed by its #handle from memory_recall.
 *
 * - `change`  it changed (moved, new job, new price): the new text becomes
 *             the current version; the old one stays as the past.
 * - `correct` it was wrong: the new text replaces it from the start; the
 *             wrong version is never offered as the past.
 * - `end`     it stopped holding and nothing replaces it (today, or `at`).
 * - `confirm` the owner said it again or agreed: fresher and surer.
 *
 * Writes (change/correct) go through the same guard as memory_write.
 */
import { num, obj, oneOf, opt, str, union } from "@earendil-works/pi-schema";
import { defineTool, type Tool } from "@spriessen/ext";
import type { MemoryService } from "./memory.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import { parseWhen } from "./dates.ts";
import { causeText, dayOf, handleOf } from "./handles.ts";
import { guardedWrite, type GuardDeps } from "./tools-write.ts";

const UpdateParams = obj(
  {
    id: str({ description: "The fact's #handle, from memory_recall." }),
    op: oneOf(["change", "correct", "end", "confirm"], {
      description:
        "change: it is different now (keeps the old as the past). correct: it was wrong. " +
        "end: it no longer holds and nothing replaces it. confirm: the owner said it again or agreed.",
    }),
    text: opt(str({ description: "change/correct: the new, self-contained text of the fact." })),
    at: opt(
      union([str(), num()], {
        description:
          "change: the day the new version started; end: the day it stops holding (YYYY-MM-DD, default today).",
      }),
    ),
  },
  { open: true },
);

const text = (value: string, isError = false) => ({
  output: [{ type: "text" as const, text: value }],
  ...(isError ? { isError: true as const } : {}),
});

export const updateTool = (
  memory: MemoryService,
  profiles: ProfilesService,
  guardDeps: GuardDeps,
): Tool =>
  defineTool({
    name: "memory_update",
    description:
      "Update a fact you already hold, by its #handle from memory_recall: `change` when it " +
      "became different (moved, new job), `correct` when it was wrong, `end` when it stopped " +
      "holding with nothing in its place, `confirm` when the owner said it again or agreed. " +
      "Use this instead of writing a second fact that contradicts the first.",
    parameters: UpdateParams,
    execute: async (args, api) => {
      const conversationId = String(api.conversationId);
      const scope = profiles.scopeOf(conversationId);
      if (scope === undefined)
        return text("refused: this conversation belongs to no profile.", true);
      try {
        if (args.op === "change" || args.op === "correct") {
          if (args.text === undefined || args.text.trim() === "") {
            return text(`refused: ${args.op} needs the new text of the fact.`, true);
          }
          return await guardedWrite(memory, guardDeps, scope, conversationId, {
            text: args.text,
            replaces: args.id,
            ...(args.op === "change" && args.at !== undefined ? { validFrom: args.at } : {}),
            ...(args.op === "correct" ? { correction: true } : {}),
          });
        }
        if (args.op === "end") {
          const ended = await memory.end(
            scope.owner,
            scope.profileId,
            args.id,
            parseWhen(args.at),
            conversationId,
          );
          return text(
            ended.retired
              ? `ended ${handleOf(ended.id)}: it no longer holds (history kept).`
              : `${handleOf(ended.id)} holds until ${dayOf(ended.endsAt)}; recall drops it after that.`,
          );
        }
        const confirmed = await memory.confirm(
          scope.owner,
          scope.profileId,
          args.id,
          conversationId,
        );
        return text(`confirmed ${handleOf(confirmed.id)} (${confirmed.confirmations}×).`);
      } catch (cause) {
        return text(`refused: ${causeText(cause)}`, true);
      }
    },
  });
