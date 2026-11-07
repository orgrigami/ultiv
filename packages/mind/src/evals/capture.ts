/**
 * Saving a chat message as an eval case: the owner's message, where its chat
 * forks just before it, and what the bot did then (its reply text and the
 * tools it called, up to the owner's next message). Only the owner's own
 * chats and main chats; another owner's chat reads as missing.
 */
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { InvalidInput, NotFound } from "@spriessen/core";
import type { EvalCase, EvalCaseCreate, TranscriptEntry } from "@spriessen/contracts";
import type { ConverseService } from "../converse/converse.ts";
import { projectTranscript } from "../converse/steps.ts";
import { isOwnerInput, locateEntry } from "../profiles/branch.ts";
import type { ProfilesService } from "../profiles/profiles.ts";

export type CaptureDeps = {
  readonly converse: ConverseService;
  readonly profiles: ProfilesService;
};

const TITLE_CHARS = 60;

/** The bot's reply and tool calls in the steps after the owner's message. */
export const outcomeOf = (
  steps: readonly TranscriptEntry[],
): { reply: string; tools: string[] } => ({
  reply: steps
    .flatMap((step) => (step.kind === "output" && step.text !== "" ? [step.text] : []))
    .join("\n\n"),
  tools: steps.flatMap((step) => (step.kind === "tool" ? [step.step.name] : [])),
});

/** The entries that answered the owner's message: up to their next one. */
const answerOf = (following: readonly EntryRecord[]): EntryRecord[] => {
  const end = following.findIndex(isOwnerInput);
  return [...(end === -1 ? following : following.slice(0, end))];
};

export const captureCase = async (
  deps: CaptureDeps,
  owner: string,
  input: EvalCaseCreate,
): Promise<EvalCase> => {
  const row = await deps.profiles.rowOf(input.sessionId);
  if (row === undefined || row.owner !== owner) {
    throw new NotFound({ what: `session ${input.sessionId}` });
  }
  if (row.kind !== "session" && row.kind !== "main") {
    throw new InvalidInput({ reason: "only your chats can be saved as tests" });
  }
  const conversationId = await Effect.runPromise(
    deps.converse.conversationIdOf(await deps.profiles.keyOfRow(row)),
  );
  const found =
    conversationId === undefined
      ? undefined
      : await locateEntry(deps, String(conversationId), Math.floor(input.at / 100));
  if (conversationId === undefined || found === undefined) {
    throw new NotFound({ what: `message ${input.at} in this chat` });
  }
  if (!isOwnerInput(found.target)) {
    throw new InvalidInput({ reason: "save one of your own messages as a test" });
  }
  const [message] = projectTranscript([found.target], undefined, false);
  const text = message?.kind === "input" ? message.text : "";
  if (text === "") throw new InvalidInput({ reason: "that message has no text to replay" });
  const steps = projectTranscript([found.target, ...answerOf(found.following)], undefined, false);
  return {
    id: randomUUID(),
    owner,
    profileId: row.profile,
    title: (input.title?.trim() || text.replace(/\s+/g, " ")).slice(0, TITLE_CHARS),
    sessionId: input.sessionId,
    at: input.at,
    conversationId: String(conversationId),
    forkAt: found.previous === undefined ? null : Number(found.previous.id),
    input: text,
    reference: outcomeOf(steps.slice(1)),
    expect: input.expect ?? {},
    createdAt: Date.now(),
  };
};
