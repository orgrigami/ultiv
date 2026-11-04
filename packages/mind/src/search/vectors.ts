/**
 * The optional meaning leg: embeddings stored as float32 blobs beside the
 * FTS rows and searched by an exact cosine scan (no vector extension; a
 * bot's memory and chats are small enough). Off by default — words,
 * synonyms and trigrams already cover most recall. Where the vectors come
 * from (a local Ollama, any catalog provider with an embedding API, any
 * OpenAI-compatible endpoint) is search/embedders.ts. Facts and messages
 * are embedded lazily, a batch per search, and a vague question ("that
 * idea we had about the garden") finds what it means. Any failure drops
 * the leg for that search: search degrades to words, it never breaks.
 */

export interface Embedder {
  /** Stored with each vector: a new model re-embeds instead of mixing spaces. */
  readonly model: string;
  /**
   * Whether texts leave the machine (and the owner's own network). A remote
   * embedder is never sent tool results: pages, mail and files a bot read
   * stay out of a third party's hands.
   */
  readonly remote: () => boolean;
  readonly embed: (texts: readonly string[]) => Promise<Float32Array[]>;
}

/** A neighbour below this cosine is not a match, whatever its rank. */
export const MIN_SIMILARITY = 0.3;
/** Rows embedded per search call; the rest wait for the next one. */
export const FILL_PER_CALL = 64;
const BATCH = 32;

const WARN_EVERY_MS = 10 * 60_000;
let lastWarned = 0;

/** A failed meaning leg, logged at most once per ten minutes (not per search). */
export const reportEmbeddingFailure = (where: string, cause: unknown): void => {
  const now = Date.now();
  if (now - lastWarned < WARN_EVERY_MS) return;
  lastWarned = now;
  console.warn(`${where}: meaning search unavailable, words only:`, String(cause).slice(0, 300));
};

export const toBlob = (vector: Float32Array): Uint8Array =>
  new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);

export const fromBlob = (blob: Uint8Array): Float32Array =>
  new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));

export const cosine = (a: Float32Array, b: Float32Array): number => {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
};

/** Embed rows that have no vector yet, in batches, and store each. */
export const fillMissing = async (
  embedder: Embedder,
  rows: readonly { readonly rowid: number; readonly text: string }[],
  put: (rowid: number, vector: Float32Array) => void,
): Promise<void> => {
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const vectors = await embedder.embed(batch.map((row) => row.text));
    batch.forEach((row, index) => {
      const vector = vectors[index];
      if (vector !== undefined) put(row.rowid, vector);
    });
  }
};

/**
 * The nearest rows to a query vector, best first — only those that stand
 * out. Models differ in their baseline: unrelated texts score ~0.05 on
 * OpenAI's small model and ~0.37 on bge-m3, so a fixed floor lets one
 * model's noise through. A row is kept when it is at least halfway from
 * the scan's median score to its top score (and never below
 * MIN_SIMILARITY): relative to what this model calls unrelated here.
 */
export const nearest = (
  query: Float32Array,
  rows: readonly { readonly rowid: number; readonly vec: Uint8Array }[],
  limit: number,
): { readonly rowid: number; readonly score: number }[] => {
  const scored = rows
    .map((row) => ({ rowid: row.rowid, score: cosine(query, fromBlob(row.vec)) }))
    .sort((a, b) => b.score - a.score);
  const top = scored[0]?.score ?? 0;
  const median = scored[Math.floor(scored.length / 2)]?.score ?? top;
  const floor = Math.max(MIN_SIMILARITY, median + (top - median) / 2);
  return scored.filter((row) => row.score >= floor).slice(0, limit);
};
