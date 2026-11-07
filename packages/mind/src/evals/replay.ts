/**
 * Replaying one eval case: fork its chat just before the owner's message
 * (or start fresh when it was the first), adopt the fork under the bot (so
 * it speaks with its current persona and memory), mark it a replay (every
 * tool call blocked, guard.ts), put it on the bot's CURRENT tools and model
 * (or the run's model), send the message, and read back what it did. The
 * fork stays in storage under `eval:<run>:<case>`.
 */
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { ownerErrorText } from "@spriessen/core";
import type { EvalCase } from "@spriessen/contracts";
import type { ConverseService } from "../converse/converse.ts";
import { projectTranscript } from "../converse/steps.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import { outcomeOf } from "./capture.ts";
import type { ReplayGuard } from "./guard.ts";

export type ReplayDeps = {
  readonly converse: ConverseService;
  readonly profiles: ProfilesService;
  readonly guard: ReplayGuard;
};

export type ReplayOutcome = {
  readonly reply: string;
  readonly tools: string[];
  readonly error: string | null;
};

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

/** Entries a replay's answer can span. */
const SCAN = 500;

export const replayKey = (runId: string, caseId: string): string => `eval:${runId}:${caseId}`;

export const replayCase = async (
  deps: ReplayDeps,
  item: EvalCase,
  runId: string,
  model: string | null,
): Promise<ReplayOutcome> => {
  try {
    const profile = await deps.profiles.get(item.owner, item.profileId);
    if (profile === undefined) return { reply: "", tools: [], error: "This bot no longer exists." };
    const key = replayKey(runId, item.id);
    if (item.forkAt !== null)
      await run(deps.converse.forkInto(item.conversationId, item.forkAt, key));
    await deps.profiles.adoptConversation(key, {
      owner: item.owner,
      profileId: item.profileId,
      kind: "session",
      participants: null,
    });
    const conversation = await run(deps.converse.ensure(key));
    const conversationId = String(conversation.id);
    // Blocked before the first input reaches the model.
    await deps.guard.add(conversationId);
    const agent = deps.profiles.agentFor(profile);
    const effort = model === null ? (profile.model?.effort ?? "") : "";
    await run(
      deps.converse.configure(conversation, {
        model: model ?? profile.model?.id ?? null,
        effort: effort === "" ? null : (effort as ModelThinkingLevel),
        ...(agent.tools !== undefined ? { tools: agent.tools } : {}),
      }),
    );
    await run(deps.converse.turn(conversation, item.input));
    const entries = await run(deps.converse.entriesAfter(conversationId, item.forkAt ?? 0, SCAN));
    const steps = projectTranscript(entries, undefined, false).filter(
      (step) => step.kind !== "input",
    );
    return { ...outcomeOf(steps), error: null };
  } catch (cause) {
    console.error(`eval replay of case ${item.id} failed:`, cause);
    return { reply: "", tools: [], error: ownerErrorText(cause) };
  }
};
