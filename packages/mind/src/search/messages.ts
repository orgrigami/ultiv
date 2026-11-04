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
import { FILL_PER_CALL, fillMissing, nearest, toBlob, type Embedder } from "./vectors.ts";

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
       WHERE v.rowid IS NULL AND r.owner = ? AND r.profile = ?
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

export const messageSearch = (search: SearchDb, embedder?: Embedder): MessageSearch => {
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
  const deleteRows = db.prepare("DELETE FROM msg_rows WHERE conversation = ?");
  const deleteCursor = db.prepare("DELETE FROM msg_cursor WHERE conversation = ?");

  const deleteVec = db.prepare("DELETE FROM msg_vec WHERE rowid = ?");
  const dropConversation = (conversation: string): void => {
    for (const row of rowsOfConversation.all(conversation) as { rowid: number }[]) {
      deleteTerms.run(row.rowid);
      deleteGrams.run(row.rowid);
      deleteVec.run(row.rowid);
    }
    deleteRows.run(conversation);
    deleteCursor.run(conversation);
  };

  const filters = (query: MessageQuery): { sql: string; params: (string | number)[] } => {
    const clauses = ["r.owner = ?", "r.profile = ?"];
    const params: (string | number)[] = [query.owner, query.profile];
    if (query.since !== undefined) {
      clauses.push("r.at >= ?");
      params.push(query.since);
    }
    if (query.until !== undefined) {
      clauses.push("r.at <= ?");
      params.push(query.until);
    }
    if (query.role !== undefined) {
      clauses.push("r.role = ?");
      params.push(query.role);
    }
    if (query.session !== undefined) {
      clauses.push("r.session = ?");
      params.push(query.session);
    }
    return { sql: clauses.join(" AND "), params };
  };

  const leg = (
    table: "msg_terms" | "msg_grams",
    match: string | null,
    query: MessageQuery,
  ): Row[] => {
    if (match === null) return [];
    const where = filters(query);
    return db
      .prepare(
        `SELECT r.rowid AS rowid, r.conversation, r.session, r.entry, r.role, r.at, r.text
         FROM ${table} JOIN msg_rows r ON r.rowid = ${table}.rowid
         WHERE ${table} MATCH ? AND ${where.sql}
         ORDER BY bm25(${table}) LIMIT ?`,
      )
      .all(match, ...where.params, 100) as Row[];
  };

  return {
    sync: async (scope, conversations, readAfter) => {
      const cursors = new Map(
        (
          cursorsOf.all(scope.owner, scope.profile) as {
            conversation: string;
            last_entry: number;
          }[]
        ).map((row) => [row.conversation, row.last_entry]),
      );
      const listed = new Set(conversations.map((ref) => ref.conversation));
      let added = 0;
      search.tx(() => {
        for (const conversation of cursors.keys()) {
          if (!listed.has(conversation)) dropConversation(conversation);
        }
      });
      for (const ref of conversations) {
        let last = cursors.get(ref.conversation) ?? 0;
        for (;;) {
          const entries = await readAfter(ref.conversation, last);
          if (entries.length === 0) break;
          search.tx(() => {
            for (const entry of entries) {
              const id = Number(entry.id);
              last = Math.max(last, id);
              const message = messageOf(entry);
              if (message === null) continue;
              const inserted = insertRow.run(
                ref.conversation,
                id,
                scope.owner,
                scope.profile,
                ref.session,
                message.role,
                message.at,
                message.text,
              );
              if (inserted.changes === 0) continue;
              const terms = termsOf(message.text);
              insertTerms.run(inserted.lastInsertRowid, terms.terms, terms.concepts);
              insertGrams.run(inserted.lastInsertRowid, message.text);
              added += 1;
            }
            setCursor.run(ref.conversation, scope.owner, scope.profile, ref.session, last);
          });
          if (entries.length < BATCH) break;
        }
      }
      return added;
    },
    search: async (query) => {
      const meaning =
        embedder === undefined
          ? []
          : await meaningLeg(search, embedder, query, filters(query)).catch((cause: unknown) => {
              console.warn("history meaning search unavailable:", String(cause).slice(0, 200));
              return [] as Row[];
            });
      const words = leg("msg_terms", termsQuery(query.query), query);
      const grams = leg("msg_grams", gramsQuery(query.query), query);
      // Trigrams find on their own only when the words found almost nothing.
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
          return row === undefined
            ? []
            : [
                {
                  conversation: row.conversation,
                  session: row.session,
                  entry: row.entry,
                  role: row.role,
                  at: row.at,
                  snippet: snippetOf(row.text, query.query),
                },
              ];
        });
    },
    drop: (owner, profile) =>
      search.tx(() => {
        for (const row of cursorsOf.all(owner, profile) as { conversation: string }[]) {
          dropConversation(row.conversation);
        }
      }),
  };
};
