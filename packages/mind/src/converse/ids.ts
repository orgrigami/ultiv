import type { ConversationId } from "@earendil-works/pi-durable";

/** Conversation ids are numeric today; accept any string form losslessly. */
export const conversationIdFrom = (id: string): ConversationId => {
  const numeric = Number(id);
  return (Number.isSafeInteger(numeric) && numeric >= 0
    ? numeric
    : id) as unknown as ConversationId;
};

/** The text of a stored model message's content (a string, or its text blocks joined). */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => String((block as { text?: string }).text ?? "")).join("");
  }
  return JSON.stringify(content);
}
