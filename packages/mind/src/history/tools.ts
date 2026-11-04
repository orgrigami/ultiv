/**
 * History as a native tool: `history_search`. The entity rereads its own
 * conversations — decisions, commitments, names, dates — instead of
 * re-asking what a past chat already settled. Ranked full-text search over
 * this bot's chats only (never a sibling's), bilingual, typo-tolerant;
 * a time phrase in the query ("last week", "kemarin") narrows the window.
 * A read, never gated.
 */
import { Type } from "typebox";
import { defineTool, type Tool } from "@spriessen/ext";
import type { HistoryHit, HistoryService } from "./history.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import { parseWhen } from "../memory/dates.ts";
import { causeText, dayOf } from "../memory/handles.ts";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;

const WHO: Readonly<Record<string, string>> = {
  user: "owner",
  assistant: "you",
  tool: "tool result",
};

/** One hit as the model reads it: day, who, which chat, the words. */
export const hitLine = (hit: HistoryHit): string => {
  const day = hit.at > 0 ? `${dayOf(hit.at)} · ` : "";
  const chat = hit.sessionTitle !== "" ? ` in "${hit.sessionTitle}"` : "";
  return `[${day}${WHO[hit.role] ?? hit.role}${chat}] ${hit.snippet}`;
};

export const historyTools = (
  history: HistoryService,
  profiles: ProfilesService,
): readonly Tool[] => [
  defineTool({
    name: "history_search",
    description:
      "Search YOUR past conversations (all of this bot's chats, never another bot's) for what " +
      "was said or decided; use it before re-asking the owner anything a previous chat may " +
      "have settled. Words in English or Indonesian, any order; a misspelling still finds. " +
      'A time phrase in the query ("last week", "kemarin", "in March") narrows the search.',
    parameters: Type.Object({
      query: Type.String({ description: "What to look for, in words." }),
      since: Type.Optional(Type.String({ description: "Only from this day on (YYYY-MM-DD)." })),
      until: Type.Optional(Type.String({ description: "Only up to this day (YYYY-MM-DD)." })),
      who: Type.Optional(
        Type.Union([Type.Literal("owner"), Type.Literal("you"), Type.Literal("tool")], {
          description: "Only what the owner said, what you said, or tool results.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({ description: `Max hits (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` }),
      ),
    }),
    structuredOutputSchema: Type.Array(
      Type.Object({
        sessionId: Type.String(),
        sessionTitle: Type.String(),
        kind: Type.String(),
        role: Type.String(),
        snippet: Type.String(),
        at: Type.Number(),
      }),
    ),
    execute: async (args, api) => {
      const scope = profiles.scopeOf(String(api.conversationId));
      const say = (text: string, hits: readonly HistoryHit[] = []) => ({
        output: [{ type: "text" as const, text }],
        structuredOutput: hits.map((hit) => ({ ...hit })),
      });
      if (scope === undefined) return say("no history: this conversation belongs to no profile.");
      const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
      let since: number | undefined;
      let until: number | undefined;
      try {
        since = parseWhen(args.since);
        const last = parseWhen(args.until);
        until = last === undefined ? undefined : last + 86_399_999;
      } catch (cause) {
        return say(causeText(cause));
      }
      const role =
        args.who === "owner"
          ? "user"
          : args.who === "you"
            ? "assistant"
            : args.who === "tool"
              ? "tool"
              : undefined;
      const hits = await history.search(scope.owner, scope.profileId, args.query, limit, {
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}),
        ...(role !== undefined ? { role } : {}),
      });
      return hits.length === 0
        ? say(`nothing found for "${args.query}"`)
        : say(hits.map(hitLine).join("\n"), hits);
    },
  }),
];
