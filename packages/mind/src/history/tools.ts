/**
 * History as a native tool: `history_search`. The entity rereads its own
 * transcript archive — decisions, commitments, names, dates — instead of
 * re-asking what a past conversation already settled. A read, never gated.
 */
import { Type } from "typebox";
import { defineTool, type Tool } from "@spreissen/ext";
import type { HistoryService } from "./history.ts";
import type { ProfilesService } from "../profiles/profiles.ts";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;

export const historyTools = (
  history: HistoryService,
  profiles: ProfilesService,
): readonly Tool[] => [
  defineTool({
    name: "history_search",
    description:
      "Search YOUR past conversations (this profile's sessions) for what was said or decided — " +
      "use it before re-asking the user anything a previous conversation may have settled.",
    parameters: Type.Object({
      query: Type.String({ description: "Text to look for (case-insensitive substring)." }),
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
      }),
    ),
    execute: async (args, api) => {
      const scope = profiles.scopeOf(String(api.conversationId));
      if (scope === undefined) {
        return {
          output: [
            { type: "text" as const, text: "no history: this conversation belongs to no profile." },
          ],
          structuredOutput: [],
        };
      }
      const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
      const hits = await history.search(scope.owner, scope.profileId, args.query, limit);
      return {
        output: [
          {
            type: "text" as const,
            text: hits.length === 0 ? `nothing found for "${args.query}"` : JSON.stringify(hits),
          },
        ],
        structuredOutput: hits.map((hit) => ({ ...hit })),
      };
    },
  }),
];
