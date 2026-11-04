/**
 * Conversation messages in the search sidecar: every owner message, bot
 * reply and tool result of one bot's chats, verbatim, indexed per bot. An
 * index is never asked for anything another bot said: rows carry the owner
 * and profile, and every query filters on both.
 *
 * Sync is incremental by entry-id cursor per conversation (only new entries
 * are read and written), runs before each search so results are never
 * stale, and drops the rows of chats that left the bot's list (deleted
 * chats, a purged bot). Ranking fuses BM25 over the bilingual analysis with
 * trigram overlap (typos, codes) and a light recency prior.
 */
import type { EntryRecord } from "@earendil-works/pi-durable";
import { ATTACHMENTS_MARK, INPUT_ENTRY_KIND } from "../converse/steps.ts";
import type { SearchDb } from "./db.ts";
import { gramsQuery, snippetOf, termsOf, termsQuery } from "./fts.ts";
import {
  FILL_PER_CALL,
  fillMissing,
  nearest,
  reportEmbeddingFailure,
  toBlob,
  type Embedder,
} from "./vectors.ts";
import { embedsTools } from "./embedders.ts";

export type MessageRole = "user" | "assistant" | "tool";

export interface MessageHit {
  readonly conversation: string;
  readonly session: string;
  readonly entry: number;
  readonly role: MessageRole;
  readonly at: number;
  readonly snippet: string;
}

export interface ConversationRef {
  readonly conversation: string;
  readonly session: string;
}

export interface MessageQuery {
  readonly owner: string;
  readonly profile: string;
  readonly query: string;
  readonly since?: number;
  readonly until?: number;
  readonly role?: MessageRole;
  readonly session?: string;
  readonly limit: number;
}

export interface MessageSearch {
  /** Index what is new in these conversations; drop the bot's chats not listed. */
  readonly sync: (
    scope: { readonly owner: string; readonly profile: string },
    conversations: readonly ConversationRef[],
    readAfter: (conversation: string, afterEntry: number) => Promise<readonly EntryRecord[]>,
  ) => Promise<number>;
  readonly search: (query: MessageQuery) => Promise<MessageHit[]>;
  /** Forget a bot's rows (a purged bot). */
  readonly drop: (owner: string, profile: string) => void;
}

/** Tool output beyond this is not indexed (pages, dumps): the start says what it was. */
const TOOL_TEXT_CAP = 2_000;
const TEXT_CAP = 8_000;
const RRF_K = 60;
const BATCH = 500;

const blocksText = (content: unknown, kinds: readonly string[]): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      const typed = block as { type?: unknown; text?: unknown };
      return kinds.includes(String(typed.type)) && typeof typed.text === "string"
        ? [typed.text]
        : [];
    })
    .join(" ");
};

/**
 * One transcript entry as an indexable message, or null. Only what was said
 * counts: the owner's input, the bot's reply text (never its thinking) and
 * tool results; system/section entries, compaction summaries and
 * bookkeeping are not messages.
 */
export const messageOf = (
  entry: EntryRecord,
): { readonly role: MessageRole; readonly text: string; readonly at: number } | null => {
  const role: MessageRole | null =
    entry.kind === "pi.user" || entry.kind === INPUT_ENTRY_KIND
      ? "user"
      : entry.kind === "pi.assistant"
        ? "assistant"
        : entry.kind === "pi.tool-result"
          ? "tool"
          : null;
  if (role === null) return null;
  let at = 0;
  const parts: string[] = [];
  for (const message of entry.model ?? []) {
    const typed = message as { content?: unknown; timestamp?: unknown };
    if (typeof typed.timestamp === "number") at = Math.max(at, typed.timestamp);
    parts.push(blocksText(typed.content, ["text"]));
  }
  // Attachment reference lines are machinery: search what was said.
  const said = (parts.join(" ").split(ATTACHMENTS_MARK)[0] ?? "").trim();
  if (said === "") return null;
  const text = said.slice(0, role === "tool" ? TOOL_TEXT_CAP : TEXT_CAP);
  return { role, text, at: at === 0 ? Date.now() : at };
};

type Row = {
  rowid: number;
  conversation: string;
  session: string;
  entry: number;
  role: MessageRole;
  at: number;
  text: string;
};

/** The meaning leg over one bot's messages: fill missing vectors, then a cosine scan. */
const meaningLeg = async (
  search: SearchDb,
  embedder: Embedder,
  query: MessageQuery,
  where: { readonly sql: string; readonly params: (string | number)[] },
): Promise<Row[]> => {
  const { db } = search;
  const missing = db
    .prepare(
      `SELECT r.rowid AS rowid, r.text AS text FROM msg_rows r
       LEFT JOIN msg_vec v ON v.rowid = r.rowid AND v.model = ?
       WHERE v.rowid IS NULL AND r.owner = ? AND r.profile = ?${embedsTools(embedder) ? "" : " AND r.role != 'tool'"}
       ORDER BY r.at DESC LIMIT ?`,
    )
    .all(embedder.model, query.owner, query.profile, FILL_PER_CALL) as {
    rowid: number;
    text: string;
  }[];
  const put = db.prepare("INSERT OR REPLACE INTO msg_vec (rowid, model, vec) VALUES (?, ?, ?)");
  await fillMissing(embedder, missing, (rowid, vector) =>
    put.run(rowid, embedder.model, toBlob(vector)),
  );
  const [vector] = await embedder.embed([query.query]);
  if (vector === undefined) return [];
  const rows = db
    .prepare(
      `SELECT r.rowid AS rowid, r.conversation, r.session, r.entry, r.role, r.at, r.text, v.vec AS vec
       FROM msg_vec v JOIN msg_rows r ON r.rowid = v.rowid WHERE v.model = ? AND ${where.sql}`,
    )
    .all(embedder.model, ...where.params) as (Row & { vec: Uint8Array })[];
  const byId = new Map(rows.map((row) => [row.rowid, row]));
  return nearest(vector, rows, 30).flatMap((hit) => {
    const row = byId.get(hit.rowid);
    return row === undefined ? [] : [row];
  });
};

/** The WHERE clauses every message query carries: always the owner and the bot. */
const filtersOf = (query: MessageQuery): { sql: string; params: (string | number)[] } => {
  const clauses = ["r.owner = ?", "r.profile = ?"];
  const params: (string | number)[] = [query.owner, query.profile];
  const optional: [string, string | number | undefined][] = [
    ["r.at >= ?", query.since],
    ["r.at <= ?", query.until],
    ["r.role = ?", query.role],
    ["r.session = ?", query.session],
  ];
  for (const [clause, value] of optional) {
    if (value === undefined) continue;
    clauses.push(clause);
    params.push(value);
  }
  return { sql: clauses.join(" AND "), params };
};

/** One FTS leg over one bot's messages, BM25-ranked. */
const ftsLeg = (
  search: SearchDb,
  table: "msg_terms" | "msg_grams",
  match: string | null,
  query: MessageQuery,
): Row[] => {
  if (match === null) return [];
  const where = filtersOf(query);
  return search.db
    .prepare(
      `SELECT r.rowid AS rowid, r.conversation, r.session, r.entry, r.role, r.at, r.text
       FROM ${table} JOIN msg_rows r ON r.rowid = ${table}.rowid
       WHERE ${table} MATCH ? AND ${where.sql}
       ORDER BY bm25(${table}) LIMIT ?`,
    )
    .all(match, ...where.params, 100) as Row[];
};

/** Ranked search: words, letters (on their own only when words found little), meaning, recency. */
const searchMessages = async (
  search: SearchDb,
  embedder: Embedder | undefined,
  query: MessageQuery,
): Promise<MessageHit[]> => {
  const meaning =
    embedder === undefined
      ? []
      : await meaningLeg(search, embedder, query, filtersOf(query)).catch((cause: unknown) => {
          reportEmbeddingFailure("history search", cause);
          return [] as Row[];
        });
  const words = ftsLeg(search, "msg_terms", termsQuery(query.query), query);
  const grams = ftsLeg(search, "msg_grams", gramsQuery(query.query), query);
  const found = new Set([...words, ...meaning].map((row) => row.rowid));
  const gramLeg = found.size < 3 ? grams : grams.filter((row) => found.has(row.rowid));
  const byId = new Map<number, Row>();
  const score = new Map<number, number>();
  const add = (rows: readonly Row[], weight: number): void =>
    rows.forEach((row, rank) => {
      byId.set(row.rowid, row);
      score.set(row.rowid, (score.get(row.rowid) ?? 0) + weight / (RRF_K + rank + 1));
    });
  add(words, 1);
  add(gramLeg, 0.4);
  add(meaning, 0.8);
  // Recency as a light prior over what matched: newer wins a near tie.
  add(
    [...byId.values()].sort((a, b) => b.at - a.at),
    0.2,
  );
  return [...score]
    .sort((a, b) => b[1] - a[1])
    .slice(0, query.limit)
    .flatMap(([rowid]) => {
      const row = byId.get(rowid);
      if (row === undefined) return [];
      const { conversation, session, entry, role, at } = row;
      return [
        { conversation, session, entry, role, at, snippet: snippetOf(row.text, query.query) },
      ];
    });
};

/** The write side: cursor-driven indexing and dropping, one bot at a time. */
const messageWriter = (search: SearchDb) => {
  const { db } = search;
  const cursorsOf = db.prepare(
    "SELECT conversation, last_entry FROM msg_cursor WHERE owner = ? AND profile = ?",
  );
  const setCursor = db.prepare(
    `INSERT INTO msg_cursor (conversation, owner, profile, session, last_entry) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (conversation) DO UPDATE SET last_entry = excluded.last_entry, session = excluded.session`,
  );
  const insertRow = db.prepare(
    `INSERT OR IGNORE INTO msg_rows (conversation, entry, owner, profile, session, role, at, text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertTerms = db.prepare("INSERT INTO msg_terms (rowid, terms, concepts) VALUES (?, ?, ?)");
  const insertGrams = db.prepare("INSERT INTO msg_grams (rowid, text) VALUES (?, ?)");
  const rowsOfConversation = db.prepare("SELECT rowid FROM msg_rows WHERE conversation = ?");
  const deleteTerms = db.prepare("DELETE FROM msg_terms WHERE rowid = ?");
  const deleteGrams = db.prepare("DELETE FROM msg_grams WHERE rowid = ?");
  const deleteVec = db.prepare("DELETE FROM msg_vec WHERE rowid = ?");
  const deleteRows = db.prepare("DELETE FROM msg_rows WHERE conversation = ?");
  const deleteCursor = db.prepare("DELETE FROM msg_cursor WHERE conversation = ?");

  const dropConversation = (conversation: string): void => {
    for (const row of rowsOfConversation.all(conversation) as { rowid: number }[]) {
      deleteTerms.run(row.rowid);
      deleteGrams.run(row.rowid);
      deleteVec.run(row.rowid);
    }
    deleteRows.run(conversation);
    deleteCursor.run(conversation);
  };

  /** Index one batch of a conversation's entries; returns the rows added and the new cursor. */
  const write = (
    scope: { readonly owner: string; readonly profile: string },
    ref: ConversationRef,
    entries: readonly EntryRecord[],
    from: number,
  ): { added: number; last: number } => {
    let added = 0;
    let last = from;
    search.tx(() => {
      for (const entry of entries) {
        const id = Number(entry.id);
        last = Math.max(last, id);
        const message = messageOf(entry);
        if (message === null) continue;
        const { owner, profile } = scope;
        const row = [
          ref.conversation,
          id,
          owner,
          profile,
          ref.session,
          message.role,
          message.at,
          message.text,
        ] as const;
        const inserted = insertRow.run(...row);
        if (inserted.changes === 0) continue;
        const terms = termsOf(message.text);
        insertTerms.run(inserted.lastInsertRowid, terms.terms, terms.concepts);
        insertGrams.run(inserted.lastInsertRowid, message.text);
        added += 1;
      }
      setCursor.run(ref.conversation, scope.owner, scope.profile, ref.session, last);
    });
    return { added, last };
  };

  const cursors = (owner: string, profile: string): Map<string, number> =>
    new Map(
      (cursorsOf.all(owner, profile) as { conversation: string; last_entry: number }[]).map(
        (row) => [row.conversation, row.last_entry],
      ),
    );

  return { dropConversation, write, cursors };
};

export const messageSearch = (search: SearchDb, embedder?: Embedder): MessageSearch => {
  const writer = messageWriter(search);
  return {
    sync: async (scope, conversations, readAfter) => {
      const cursors = writer.cursors(scope.owner, scope.profile);
      // Keys are text: a numeric id would never match its stored cursor and
      // every sync would drop and re-index the chat.
      const refs = conversations.map((ref) => ({ ...ref, conversation: String(ref.conversation) }));
      const listed = new Set(refs.map((ref) => ref.conversation));
      search.tx(() => {
        for (const conversation of cursors.keys()) {
          if (!listed.has(conversation)) writer.dropConversation(conversation);
        }
      });
      let added = 0;
      for (const ref of refs) {
        let last = cursors.get(ref.conversation) ?? 0;
        for (;;) {
          const entries = await readAfter(ref.conversation, last);
          if (entries.length === 0) break;
          const wrote = writer.write(scope, ref, entries, last);
          added += wrote.added;
          last = wrote.last;
          if (entries.length < BATCH) break;
        }
      }
      return added;
    },
    search: (query) => searchMessages(search, embedder, query),
    drop: (owner, profile) =>
      search.tx(() => {
        for (const conversation of writer.cursors(owner, profile).keys()) {
          writer.dropConversation(conversation);
        }
      }),
  };
};
