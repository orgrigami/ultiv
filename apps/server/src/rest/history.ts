/**
 * GET /api/history/search?q=…[&bot=<id>][&since=YYYY-MM-DD][&until=…][&who=owner|bot|tool][&limit=n]
 *
 * The owner's search over what their bots' chats said. Each bot's chats are
 * indexed and searched on their own (the same bounded search a bot runs
 * with history_search), so a hit always belongs to exactly one bot. With
 * `bot`, that bot only (another owner's bot answers like a missing one);
 * without, each of the owner's bots, grouped, bots with more matches first.
 * A time phrase in `q` ("last week", "kemarin") narrows it like the tool.
 */
import type { HistoryGroup, HistorySearch } from "@spriessen/contracts";
import { parseWhen } from "@spriessen/mind";
import { ownsProfile } from "./owner-scope.ts";
import { queryOr, type RouteArgs } from "./types.ts";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
/** Bots searched at once when no bot is named; the rest wait for a narrower query. */
const MAX_BOTS = 24;

const ROLE: Readonly<Record<string, "user" | "assistant" | "tool">> = {
  owner: "user",
  bot: "assistant",
  tool: "tool",
};

export async function historyRoutes(args: RouteArgs): Promise<boolean> {
  if (args.path !== "/api/history/search" || args.req.method !== "GET") return false;
  const query = (queryOr(args, "q") ?? "").trim();
  const bot = queryOr(args, "bot");
  const limitText = Number(queryOr(args, "limit") ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(limitText)
    ? Math.min(Math.max(limitText, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const who = queryOr(args, "who");
  let since: number | undefined;
  let until: number | undefined;
  try {
    since = parseWhen(queryOr(args, "since"));
    const last = parseWhen(queryOr(args, "until"));
    until = last === undefined ? undefined : last + 86_399_999;
  } catch (cause) {
    args.json(400, { error: (cause as { reason?: string }).reason ?? "that date is not a day" });
    return true;
  }
  const empty: HistorySearch = { query, groups: [] };
  if (query.length < 2) {
    args.json(200, empty);
    return true;
  }
  if (bot !== undefined && !(await ownsProfile(args, bot))) {
    args.json(404, { error: "unknown bot" });
    return true;
  }
  const bots =
    bot !== undefined
      ? [bot]
      : (await args.mind.profiles.list(args.owner))
          .filter((profile) => profile.archivedAt === null)
          .map((profile) => profile.id)
          .slice(0, MAX_BOTS);
  const role = who === undefined ? undefined : ROLE[who];
  const groups: HistoryGroup[] = [];
  for (const profile of bots) {
    const hits = await args.mind.history.search(args.owner, profile, query, limit, {
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
      ...(role !== undefined ? { role } : {}),
    });
    if (hits.length > 0) groups.push({ profile, hits: hits.map((hit) => ({ ...hit })) });
  }
  // Scores of different bots' indexes don't compare; how much matched does.
  groups.sort((a, b) => b.hits.length - a.hits.length);
  args.json(200, { query, groups } satisfies HistorySearch);
  return true;
}
