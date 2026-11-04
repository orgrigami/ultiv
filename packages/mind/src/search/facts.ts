/**
 * Memory facts in the search sidecar. A store's facts sync by per-fact
 * signature (text hash, tags, entity names): only what changed is rewritten,
 * so the sync runs before every recall and the index is never stale.
 * Search returns fact ids ranked two ways — BM25 over the analyzed terms
 * (text ×1, tags ×2, entity names ×2, synonym concepts ×0.8) and trigram
 * overlap — and recall fuses them with its entity and prior legs.
 */
import type { MemoryFact } from "@spriessen/contracts";
import type { SearchDb } from "./db.ts";
import { gramsQuery, termsOf, termsQuery } from "./fts.ts";
import { FILL_PER_CALL, fillMissing, nearest, toBlob, type Embedder } from "./vectors.ts";

export interface FactSearch {
  /** Bring one store's rows in line with its facts. */
  readonly sync: (
    store: string,
    facts: readonly MemoryFact[],
    namesOf: (entityId: string) => readonly string[],
  ) => void;
  /** BM25-ranked ids over the given stores. */
  readonly lexical: (stores: readonly string[], query: string, limit: number) => string[];
  /** Trigram-ranked ids over the given stores. */
  readonly fuzzy: (stores: readonly string[], query: string, limit: number) => string[];
  /** Forget a whole store (a purged bot). */
  readonly drop: (store: string) => void;
  /**
   * Meaning-ranked ids over the given stores, when an embedding model is
   * configured (search/vectors.ts); embeds a batch of facts without a
   * vector first. Absent without a model.
   */
  readonly semantic?: (
    stores: readonly string[],
    query: string,
    limit: number,
  ) => Promise<string[]>;
}

const signatureOf = (fact: MemoryFact, names: readonly string[]): string =>
  `${fact.hash}|${fact.tags.join(",")}|${names.join(",")}`;

const placeholders = (count: number): string => Array.from({ length: count }, () => "?").join(",");

export const factSearch = (search: SearchDb, embedder?: Embedder): FactSearch => {
  const { db } = search;
  const rowsOf = db.prepare("SELECT rowid, id, sig FROM fact_rows WHERE store = ?");
  const insertRow = db.prepare("INSERT INTO fact_rows (id, store, sig) VALUES (?, ?, ?)");
  const updateRow = db.prepare("UPDATE fact_rows SET sig = ? WHERE rowid = ?");
  const insertTerms = db.prepare(
    "INSERT INTO fact_terms (rowid, terms, tags, names, concepts) VALUES (?, ?, ?, ?, ?)",
  );
  const insertGrams = db.prepare("INSERT INTO fact_grams (rowid, text) VALUES (?, ?)");
  const deleteTerms = db.prepare("DELETE FROM fact_terms WHERE rowid = ?");
  const deleteGrams = db.prepare("DELETE FROM fact_grams WHERE rowid = ?");
  const deleteRow = db.prepare("DELETE FROM fact_rows WHERE rowid = ?");
  const deleteVec = db.prepare("DELETE FROM fact_vec WHERE rowid = ?");

  const write = (rowid: number | bigint, fact: MemoryFact, names: readonly string[]): void => {
    const text = termsOf(fact.text);
    const tags = termsOf(fact.tags.join(" "));
    const named = termsOf(names.join(" "));
    insertTerms.run(
      rowid,
      text.terms,
      tags.terms,
      named.terms,
      [text.concepts, tags.concepts, named.concepts].join(" ").trim(),
    );
    insertGrams.run(rowid, fact.text);
  };

  const remove = (rowid: number | bigint): void => {
    deleteTerms.run(rowid);
    deleteGrams.run(rowid);
    deleteVec.run(rowid);
    deleteRow.run(rowid);
  };

  return {
    sync: (store, facts, namesOf) =>
      search.tx(() => {
        const existing = new Map(
          (rowsOf.all(store) as { rowid: number; id: string; sig: string }[]).map((row) => [
            row.id,
            row,
          ]),
        );
        for (const fact of facts) {
          const names = fact.entities.flatMap((id) => namesOf(id));
          const sig = signatureOf(fact, names);
          const row = existing.get(fact.id);
          existing.delete(fact.id);
          if (row !== undefined && row.sig === sig) continue;
          if (row !== undefined) {
            deleteTerms.run(row.rowid);
            deleteGrams.run(row.rowid);
            deleteVec.run(row.rowid);
            updateRow.run(sig, row.rowid);
            write(row.rowid, fact, names);
            continue;
          }
          const inserted = insertRow.run(fact.id, store, sig);
          write(inserted.lastInsertRowid, fact, names);
        }
        // Rows of facts no longer in the store (a purge cleared them).
        for (const row of existing.values()) remove(row.rowid);
      }),
    lexical: (stores, query, limit) =>
      rankFacts(search, "fact_terms", termsQuery(query), stores, limit),
    fuzzy: (stores, query, limit) =>
      rankFacts(search, "fact_grams", gramsQuery(query), stores, limit),
    ...(embedder !== undefined ? { semantic: semanticOf(search, embedder) } : {}),
    drop: (store) =>
      search.tx(() => {
        for (const row of rowsOf.all(store) as { rowid: number }[]) remove(row.rowid);
      }),
  };
};

/** BM25 weights per table: text, tags, entity names, concepts — or the one grams column. */
const BM25 = {
  fact_terms: "bm25(fact_terms, 1.0, 2.0, 2.0, 0.8)",
  fact_grams: "bm25(fact_grams)",
} as const;

/** One FTS leg over the given stores: ranked fact ids. */
const rankFacts = (
  search: SearchDb,
  table: keyof typeof BM25,
  match: string | null,
  stores: readonly string[],
  limit: number,
): string[] => {
  if (match === null || stores.length === 0) return [];
  const rows = search.db
    .prepare(
      `SELECT r.id AS id FROM ${table} JOIN fact_rows r ON r.rowid = ${table}.rowid
       WHERE ${table} MATCH ? AND r.store IN (${placeholders(stores.length)})
       ORDER BY ${BM25[table]} LIMIT ?`,
    )
    .all(match, ...stores, limit) as { id: string }[];
  return rows.map((row) => row.id);
};

/** The meaning leg over facts: fill missing vectors, then an exact cosine scan. */
const semanticOf =
  (search: SearchDb, embedder: Embedder) =>
  async (stores: readonly string[], query: string, limit: number): Promise<string[]> => {
    if (stores.length === 0 || query.trim() === "") return [];
    const { db } = search;
    const where = `r.store IN (${placeholders(stores.length)})`;
    const missing = db
      .prepare(
        `SELECT r.rowid AS rowid, g.text AS text FROM fact_rows r
         JOIN fact_grams g ON g.rowid = r.rowid
         LEFT JOIN fact_vec v ON v.rowid = r.rowid AND v.model = ?
         WHERE v.rowid IS NULL AND ${where} LIMIT ?`,
      )
      .all(embedder.model, ...stores, FILL_PER_CALL) as { rowid: number; text: string }[];
    const put = db.prepare("INSERT OR REPLACE INTO fact_vec (rowid, model, vec) VALUES (?, ?, ?)");
    await fillMissing(embedder, missing, (rowid, vector) =>
      put.run(rowid, embedder.model, toBlob(vector)),
    );
    const [vector] = await embedder.embed([query]);
    if (vector === undefined) return [];
    const rows = db
      .prepare(
        `SELECT v.rowid AS rowid, v.vec AS vec, r.id AS id FROM fact_vec v
         JOIN fact_rows r ON r.rowid = v.rowid WHERE v.model = ? AND ${where}`,
      )
      .all(embedder.model, ...stores) as { rowid: number; vec: Uint8Array; id: string }[];
    const ids = new Map(rows.map((row) => [row.rowid, row.id]));
    return nearest(vector, rows, limit).flatMap((hit) => {
      const id = ids.get(hit.rowid);
      return id === undefined ? [] : [id];
    });
  };
