/**
 * The History faculty: the entity can reread its own past. Transcripts are
 * already durable in the harness — this is the retrieval surface over them,
 * scoped to the asking profile's chats. With the search sidecar (the normal
 * case) it is ranked full-text search: bilingual, multi-word, typo-tolerant,
 * time-aware ("last week", "kemarin", "in March" narrow the window), over
 * every message of every chat of the bot, compaction-retired ones included.
 * Without it, a substring scan of recent chats is the fallback.
 */
import { Effect } from "effect";
import type { ConverseService } from "../converse/converse.ts";
import { ATTACHMENTS_MARK, INPUT_ENTRY_KIND } from "../converse/steps.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import type { SessionInfo } from "@spriessen/contracts";
import type { MessageRole, MessageSearch } from "../search/messages.ts";
import { timeWindowOf } from "../search/when.ts";

export interface HistoryHit {
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly kind: string;
  readonly role: string;
  readonly snippet: string;
  /** When it was said (epoch ms); 0 from the fallback scan, which does not know. */
  readonly at: number;
}

export interface HistoryFilters {
  /** Only messages at or after / before these moments (epoch ms). */
  readonly since?: number;
  readonly until?: number;
  readonly role?: MessageRole;
  /** One chat only. */
  readonly sessionId?: string;
}

/** Text of one entry's model messages, joined (user input, assistant text, tool output). */
const entryText = (entry: {
  readonly kind: string;
  readonly model?: readonly unknown[];
}): {
  role: string;
  text: string;
} => {
  const role =
    entry.kind === "pi.user" || entry.kind === INPUT_ENTRY_KIND
      ? "user"
      : entry.kind === "pi.tool-result"
        ? "tool"
        : "assistant";
  const parts: string[] = [];
  for (const message of entry.model ?? []) {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        const text = (block as { text?: string }).text;
        if (typeof text === "string" && text !== "") parts.push(text);
      }
    }
  }
  // Attachment reference lines are machinery: history searches what was said.
  const text = (parts.join(" ").split(ATTACHMENTS_MARK)[0] ?? "").trim();
  return { role, text };
};

const snippetAround = (text: string, at: number, span = 80): string => {
  const start = Math.max(0, at - span / 2);
  const end = Math.min(text.length, at + span);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
};

export interface HistoryService {
  /**
   * Search one profile's chats; best first, capped. A time phrase in the
   * query narrows the window unless `filters` set one.
   */
  readonly search: (
    owner: string,
    profileId: string,
    query: string,
    limit: number,
    filters?: HistoryFilters,
  ) => Promise<HistoryHit[]>;
  /** Forget a bot's indexed messages (purge cascade). */
  readonly drop: (owner: string, profileId: string) => void;
  /**
   * Index what is new in a bot's chats without searching — the boot
   * warm-up, so the first search on a long history is not the one that
   * waits. Returns the messages added (0 without the sidecar).
   */
  readonly index: (owner: string, profileId: string) => Promise<number>;
}

const MAX_SESSIONS = 50;
const MAX_ENTRIES_PER_SESSION = 500;

/** Entries scanned per cursor step when indexing. */
const INDEX_BATCH = 500;

export const historyService = (deps: {
  readonly converse: ConverseService;
  readonly profiles: ProfilesService;
  /** The search sidecar's message index; absent ⇒ the substring scan. */
  readonly search?: MessageSearch;
}): HistoryService => ({
  drop: (owner, profileId) => deps.search?.drop(owner, profileId),
  index: (owner, profileId) =>
    deps.search === undefined ? Promise.resolve(0) : syncBot(deps, deps.search, owner, profileId),
  search: async (owner, profileId, query, limit, filters = {}) => {
    if (query.trim() === "") return [];
    if (deps.search !== undefined) {
      try {
        return await indexedSearch(deps, deps.search, owner, profileId, query, limit, filters);
      } catch (cause) {
        console.warn("history search index unavailable, scanning:", String(cause));
      }
    }
    return scanSearch(deps, owner, profileId, query, limit);
  },
});

/** Ranked full-text search through the sidecar, after indexing what is new. */
const indexedSearch = async (
  deps: { readonly converse: ConverseService; readonly profiles: ProfilesService },
  search: MessageSearch,
  owner: string,
  profileId: string,
  query: string,
  limit: number,
  filters: HistoryFilters,
): Promise<HistoryHit[]> => {
  const rows = await deps.profiles.listSessions(owner, profileId);
  await syncBot(deps, search, owner, profileId, rows);
  const timed =
    filters.since === undefined && filters.until === undefined
      ? timeWindowOf(query)
      : { window: null, rest: query };
  const words = timed.rest.trim() === "" ? query : timed.rest;
  const since = filters.since ?? timed.window?.since;
  const until = filters.until ?? timed.window?.until;
  const hits = await search.search({
    owner,
    profile: profileId,
    query: words,
    limit,
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(filters.role !== undefined ? { role: filters.role } : {}),
    ...(filters.sessionId !== undefined ? { session: filters.sessionId } : {}),
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return hits.map((hit) => ({
    sessionId: hit.session,
    sessionTitle: byId.get(hit.session)?.title ?? "",
    kind: byId.get(hit.session)?.kind ?? "session",
    role: hit.role,
    snippet: hit.snippet,
    at: hit.at,
  }));
};

/** Index what is new in one bot's chats (and drop chats it no longer has). */
const syncBot = async (
  deps: { readonly converse: ConverseService; readonly profiles: ProfilesService },
  search: MessageSearch,
  owner: string,
  profileId: string,
  known?: readonly SessionInfo[],
): Promise<number> => {
  const rows = known ?? (await deps.profiles.listSessions(owner, profileId));
  const refs = (
    await Promise.all(
      rows.map(async (row) => {
        const key = await deps.profiles.keyOfRow(row);
        const conversation = await Effect.runPromise(deps.converse.conversationIdOf(key));
        // The harness hands conversation ids over as numbers at runtime
        // (its type says string); the index keys on the text form.
        return conversation === undefined
          ? []
          : [{ conversation: String(conversation), session: row.id }];
      }),
    )
  ).flat();
  return search.sync({ owner, profile: profileId }, refs, (conversation, after) =>
    Effect.runPromise(deps.converse.entriesAfter(conversation, after, INDEX_BATCH)),
  );
};

/** The fallback: substring match over recent chats, newest first. */
const scanSearch = async (
  deps: { readonly converse: ConverseService; readonly profiles: ProfilesService },
  owner: string,
  profileId: string,
  query: string,
  limit: number,
): Promise<HistoryHit[]> => {
  {
    const needle = query.trim().toLowerCase();
    if (needle === "") return [];
    const rows = (await deps.profiles.listSessions(owner, profileId)).slice(0, MAX_SESSIONS);
    const hits: HistoryHit[] = [];
    for (const row of rows) {
      if (hits.length >= limit) break;
      const key = await deps.profiles.keyOfRow(row);
      const cid = await Effect.runPromise(deps.converse.conversationIdOf(key));
      if (cid === undefined) continue;
      const entries = await Effect.runPromise(
        deps.converse.entriesOf(cid, MAX_ENTRIES_PER_SESSION),
      );
      for (const entry of entries) {
        if (hits.length >= limit) break;
        const { role, text } = entryText(entry);
        if (text === "") continue;
        const at = text.toLowerCase().indexOf(needle);
        if (at < 0) continue;
        hits.push({
          sessionId: row.id,
          sessionTitle: row.title,
          kind: row.kind,
          role,
          snippet: snippetAround(text, at),
          at: 0,
        });
      }
    }
    return hits;
  }
};
