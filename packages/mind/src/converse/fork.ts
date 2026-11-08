/**
 * Forking a conversation at an entry (branching a chat, eval replays): the
 * fork sees the source's entries up to and including `at`, keeps the
 * source's agent as of that entry, and continues on its own. It is mapped
 * under `key` like any app conversation, so `ensure(key)` finds it.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EntryId, Harness } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { External } from "@spriessen/core";
import { asEffect } from "./as-effect.ts";
import type { ConverseService } from "./converse.ts";
import { SessionMapDoc } from "./converse.ts";
import { conversationIdFrom } from "./ids.ts";

export const forkOps = (harness: Harness): Pick<ConverseService, "forkInto"> => ({
  forkInto: (sourceConversationId, at, key) =>
    Effect.gen(function* () {
      const source = yield* asEffect(
        "conversation open",
        harness.conversation(conversationIdFrom(sourceConversationId), BACKGROUND_CONTEXT),
      );
      if (source === undefined) {
        return yield* new External({
          op: "fork",
          cause: `no conversation ${sourceConversationId}`,
        });
      }
      const fork = yield* asEffect(
        "conversation fork",
        source.fork(
          at as unknown as EntryId,
          { ownership: { kind: "ownerless" } },
          BACKGROUND_CONTEXT,
        ),
      );
      yield* asEffect(
        "session map write",
        harness.commit(async (tx) => {
          const draft = await tx.doc(SessionMapDoc, key, { conversationId: fork.id });
          draft.conversationId = fork.id;
        }, BACKGROUND_CONTEXT),
      );
      return fork;
    }),
});
