/**
 * The search sidecar: one SQLite file (Node's built-in `node:sqlite`, FTS5,
 * no extension, no dependency) that indexes memory facts and conversation
 * messages for full-text search. It is DERIVED: the pi-durable docs and
 * transcripts stay the source of truth, every row can be rebuilt from them,
 * and deleting the file only costs a re-index. `SEARCH_DB` (default
 * `var/search.sqlite`); a mind opened on test storage keeps it in memory.
 *
 * Two FTS5 tables per corpus, joined to a plain row table by rowid:
 * - `*_terms`: our own bilingual analysis (stems + synonym concepts) written
 *   as plain tokens, tokenized `unicode61` — the BM25 leg.
 * - `*_grams`: the raw text, tokenized `trigram` — substrings, codes, names
 *   typed differently, and a typo's shared letter runs.
 * - `*_vec`: optional meaning vectors (search/vectors.ts), only when an
 *   embedding model is configured.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS fact_rows (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  store TEXT NOT NULL,
  sig TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fact_rows_store ON fact_rows (store);
CREATE VIRTUAL TABLE IF NOT EXISTS fact_terms USING fts5 (
  terms, tags, names, concepts, tokenize = 'unicode61 remove_diacritics 2'
);
CREATE VIRTUAL TABLE IF NOT EXISTS fact_grams USING fts5 (text, tokenize = 'trigram');

CREATE TABLE IF NOT EXISTS msg_rows (
  rowid INTEGER PRIMARY KEY,
  conversation TEXT NOT NULL,
  entry INTEGER NOT NULL,
  owner TEXT NOT NULL,
  profile TEXT NOT NULL,
  session TEXT NOT NULL,
  role TEXT NOT NULL,
  at INTEGER NOT NULL,
  text TEXT NOT NULL,
  UNIQUE (conversation, entry)
);
CREATE INDEX IF NOT EXISTS msg_rows_scope ON msg_rows (owner, profile, at);
CREATE INDEX IF NOT EXISTS msg_rows_session ON msg_rows (session);
CREATE VIRTUAL TABLE IF NOT EXISTS msg_terms USING fts5 (
  terms, concepts, tokenize = 'unicode61 remove_diacritics 2'
);
CREATE VIRTUAL TABLE IF NOT EXISTS msg_grams USING fts5 (text, tokenize = 'trigram');
CREATE TABLE IF NOT EXISTS fact_vec (rowid INTEGER PRIMARY KEY, model TEXT NOT NULL, vec BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS msg_vec (rowid INTEGER PRIMARY KEY, model TEXT NOT NULL, vec BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS msg_cursor (
  conversation TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  profile TEXT NOT NULL,
  session TEXT NOT NULL,
  last_entry INTEGER NOT NULL
);
`;

/** Bumped when the schema or the analysis changes: the file is rebuilt. */
export const SEARCH_SCHEMA_VERSION = "2";

export interface SearchDb {
  readonly db: DatabaseSync;
  /** Run `fn` in one write transaction. */
  readonly tx: <T>(fn: () => T) => T;
  readonly close: () => void;
}

const DROP = [
  "fact_rows",
  "fact_terms",
  "fact_grams",
  "msg_rows",
  "msg_terms",
  "msg_grams",
  "msg_cursor",
  "fact_vec",
  "msg_vec",
];

/** Open (or create) the sidecar. A schema from another version is dropped and rebuilt. */
export const openSearchDb = (path: string): SearchDb => {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 2000;");
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  const version = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as
    | { value: string }
    | undefined;
  if (version !== undefined && version.value !== SEARCH_SCHEMA_VERSION) {
    for (const table of DROP) db.exec(`DROP TABLE IF EXISTS ${table};`);
  }
  db.exec(SCHEMA);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)").run(
    SEARCH_SCHEMA_VERSION,
  );
  let depth = 0;
  const tx = <T>(fn: () => T): T => {
    if (depth > 0) return fn();
    depth += 1;
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      depth -= 1;
    }
  };
  return { db, tx, close: () => db.close() };
};
