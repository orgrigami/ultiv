/**
 * The boot heal of the chat/task split (profiles/chat-tools.ts): every
 * existing chat still offered a work tool gets the chat-only filter.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Effect } from "effect";
import type { ConverseService } from "./converse/converse.ts";
import { chatModelTools, healChatTools } from "./profiles/chat-tools.ts";
import type { ProfilesService } from "./profiles/profiles.ts";

export const healChats = async (
  converse: ConverseService,
  profiles: Pick<ProfilesService, "chatConversations">,
): Promise<void> => {
  const changed = await healChatTools({
    chats: profiles.chatConversations,
    offered: async (conversationId) => {
      const chat = await Effect.runPromise(converse.open(conversationId));
      if (chat === undefined) return undefined;
      const agent = await chat.agent(BACKGROUND_CONTEXT);
      return agent.tools.map((tool) => tool.name);
    },
    restrict: async (conversationId) => {
      const chat = await Effect.runPromise(converse.open(conversationId));
      if (chat === undefined) return;
      await Effect.runPromise(converse.configure(chat, { modelTools: chatModelTools() }));
    },
  }).catch((cause: unknown) => {
    console.error("chat tool heal failed:", cause);
    return 0;
  });
  if (changed > 0) console.log(`chats: ${changed} now hand work to tasks`);
};
