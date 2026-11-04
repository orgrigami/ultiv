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
}

const signatureOf = (fact: MemoryFact, names: readonly string[]): string =>
  `${fact.hash}|${fact.tags.join(",")}|${names.join(",")}`;

const placeholders = (count: number): string => Array.from({ length: count }, () => "?").join(",");

export const factSearch = (search: SearchDb): FactSearch => {
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
    deleteRow.run(rowid);
  };

  const ranked = (sql: string, stores: readonly string[], match: string, limit: number): string[] =>
    (db.prepare(sql).all(match, ...stores, limit) as { id: string }[]).map((row) => row.id);

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
    lexical: (stores, query, limit) => {
      const match = termsQuery(query);
      if (match === null || stores.length === 0) return [];
      return ranked(
        `SELECT r.id AS id FROM fact_terms JOIN fact_rows r ON r.rowid = fact_terms.rowid
         WHERE fact_terms MATCH ? AND r.store IN (${placeholders(stores.length)})
         ORDER BY bm25(fact_terms, 1.0, 2.0, 2.0, 0.8) LIMIT ?`,
        stores,
        match,
        limit,
      );
    },
    fuzzy: (stores, query, limit) => {
      const match = gramsQuery(query);
      if (match === null || stores.length === 0) return [];
      return ranked(
        `SELECT r.id AS id FROM fact_grams JOIN fact_rows r ON r.rowid = fact_grams.rowid
         WHERE fact_grams MATCH ? AND r.store IN (${placeholders(stores.length)})
         ORDER BY bm25(fact_grams) LIMIT ?`,
        stores,
        match,
        limit,
      );
    },
    drop: (store) =>
      search.tx(() => {
        for (const row of rowsOf.all(store) as { rowid: number }[]) remove(row.rowid);
      }),
  };
};
