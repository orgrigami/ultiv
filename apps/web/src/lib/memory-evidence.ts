/**
 * What the owner needs to judge a fact in a conflict: how the bot knows it,
 * whether it came from outside content, since when, and the chat it was
 * learned in. Pure, so the conflict card and its test read the same words.
 */
import type { MemoryV2Chat, MemoryV2Fact } from "./api-types.ts";
import * as t from "./memory-text.ts";

export const evidenceOf = (
  fact: MemoryV2Fact,
  chats: Record<string, MemoryV2Chat> | undefined,
): string[] => {
  const parts: string[] = [];
  const basis = fact.basis === undefined ? undefined : t.BASIS_WORDS[fact.basis];
  if (basis !== undefined) parts.push(basis);
  if (fact.trust === "untrusted") parts.push(t.unverifiedOutside);
  else if (fact.trust === "derived") parts.push(t.fromOutside);
  parts.push(t.sinceMeta(new Date(fact.validFrom ?? fact.createdAt).toISOString().slice(0, 10)));
  const conversation = fact.source?.conversation;
  const chat =
    conversation === null || conversation === undefined ? undefined : chats?.[conversation];
  if (chat !== undefined) {
    parts.push(t.learnedIn(chat.kind === "main" ? t.mainChatName : chat.title));
  }
  return parts;
};
